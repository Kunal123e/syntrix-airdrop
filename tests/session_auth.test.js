const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const http = require("node:http");
const Module = require("node:module");
const test = require("node:test");

const {
  ADMIN_PURPOSE,
  WORKER_PURPOSE,
  createAdminToken,
  createWorkerToken,
  isSessionAuthConfigured,
  safeStringEqual,
  verifySessionToken
} = require("../sessionAuth");
const processQueueRouter = require("../routes/processQueue");

const previousAdminSecret = process.env.ADMIN_SECRET_KEY;
const previousSessionSecret = process.env.ADMIN_SESSION_SECRET;
let serverModule;
process.env.ADMIN_SECRET_KEY = "admin-password-for-tests";
process.env.ADMIN_SESSION_SECRET = "a".repeat(64);

function signClaims(claims) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

test("admin and worker tokens are purpose-bound and expire within their role limits", () => {
  const adminToken = createAdminToken();
  const workerToken = createWorkerToken();

  assert.equal(verifySessionToken(adminToken, "admin", ADMIN_PURPOSE), true);
  assert.equal(verifySessionToken(adminToken, "worker", WORKER_PURPOSE), false);
  assert.equal(verifySessionToken(workerToken, "worker", WORKER_PURPOSE), true);
  assert.equal(verifySessionToken(workerToken, "admin", ADMIN_PURPOSE), false);
  assert.equal(verifySessionToken(process.env.ADMIN_SECRET_KEY, "admin", ADMIN_PURPOSE), false);

  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifySessionToken(signClaims({
    role: "admin",
    purpose: ADMIN_PURPOSE,
    iat: now - 901,
    exp: now + 30
  }), "admin", ADMIN_PURPOSE), false);
  assert.equal(verifySessionToken(signClaims({
    role: "worker",
    purpose: WORKER_PURPOSE,
    iat: now - 61,
    exp: now - 1
  }), "worker", WORKER_PURPOSE), false);
});

test("token validation rejects tampering, malformed encoding, and unexpected claims", () => {
  const workerToken = createWorkerToken();
  const [payload, signature] = workerToken.split(".");
  const replacement = signature.endsWith("A") ? "B" : "A";

  assert.equal(verifySessionToken(`${payload}.${signature.slice(0, -1)}${replacement}`, "worker", WORKER_PURPOSE), false);
  assert.equal(verifySessionToken(`${payload}=.${signature}`, "worker", WORKER_PURPOSE), false);
  assert.equal(verifySessionToken(`${workerToken}.extra`, "worker", WORKER_PURPOSE), false);

  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifySessionToken(signClaims({
    role: "worker",
    purpose: WORKER_PURPOSE,
    iat: now,
    exp: now + 30,
    extra: true
  }), "worker", WORKER_PURPOSE), false);
});

test("session authentication fails closed without a distinct 32-byte session secret", () => {
  const originalSessionSecret = process.env.ADMIN_SESSION_SECRET;
  const originalAdminPassword = process.env.ADMIN_SECRET_KEY;

  try {
    process.env.ADMIN_SESSION_SECRET = "a".repeat(31);
    assert.equal(isSessionAuthConfigured(), false);
    assert.throws(() => createAdminToken(), /not configured/);

    process.env.ADMIN_SESSION_SECRET = "a".repeat(64);
    process.env.ADMIN_SECRET_KEY = process.env.ADMIN_SESSION_SECRET;
    assert.equal(isSessionAuthConfigured(), false);
    assert.throws(() => createAdminToken(), /not configured/);
    assert.equal(verifySessionToken("not-a-valid-token", "admin", ADMIN_PURPOSE), false);
  } finally {
    process.env.ADMIN_SESSION_SECRET = originalSessionSecret;
    process.env.ADMIN_SECRET_KEY = originalAdminPassword;
  }
});

test("password comparison is timing-safe and rejects non-string values", () => {
  assert.equal(safeStringEqual("same", "same"), true);
  assert.equal(safeStringEqual("same", "different"), false);
  assert.equal(safeStringEqual(null, "same"), false);
});

test("process-queue accepts only worker sessions and key-status accepts only admin sessions", async (t) => {
  let rpcCalls = 0;
  let fromCalls = 0;
  const app = express();
  app.locals.supabase = {
    rpc: async () => {
      rpcCalls++;
      return { data: [], error: null };
    },
    from: () => {
      fromCalls++;
      return {
        select() { return this; },
        in() { return this; },
        is() { return this; },
        neq() { return this; },
        eq() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        then(resolve, reject) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        }
      };
    }
  };
  app.use("/api/process-queue", processQueueRouter);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/process-queue`;
  const adminToken = createAdminToken();
  const workerToken = createWorkerToken();

  const rawPasswordResponse = await fetch(baseUrl, {
    method: "POST",
    headers: { "x-admin-key": process.env.ADMIN_SECRET_KEY }
  });
  assert.equal(rawPasswordResponse.status, 403);

  const adminOnWorkerResponse = await fetch(baseUrl, {
    method: "POST",
    headers: { "x-admin-key": adminToken }
  });
  assert.equal(adminOnWorkerResponse.status, 403);

  const workerOnAdminResponse = await fetch(`${baseUrl}/key-status`, {
    headers: { "x-admin-key": workerToken }
  });
  assert.equal(workerOnAdminResponse.status, 403);
  assert.equal(rpcCalls, 0);
  assert.equal(fromCalls, 0);

  const workerResponse = await fetch(baseUrl, {
    method: "POST",
    headers: { "x-admin-key": workerToken }
  });
  assert.equal(workerResponse.status, 200);
  assert.equal((await workerResponse.json()).status, "EMPTY");
  assert.equal(rpcCalls, 1);

  const adminResponse = await fetch(`${baseUrl}/key-status`, {
    headers: { "x-admin-key": adminToken }
  });
  assert.equal(adminResponse.status, 200);
  assert.deepEqual((await adminResponse.json()).keys, []);
});

test("claim routes fail closed and internal admin wake uses a signed worker session", async (t) => {
  const originalEnv = {
    port: process.env.PORT,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseRole: process.env.SUPABASE_SERVICE_ROLE,
    rpcUrl: process.env.RPC_URL,
    privateKey: process.env.PRIVATE_KEY,
    tokenAddress: process.env.TOKEN_ADDRESS
  };
  let fromCalls = 0;
  let rpcCalls = 0;
  let app;
  let server;
  t.after(async () => {
    if (server && server.listening) {
      await new Promise((resolve, reject) => {
        server.close(err => err ? reject(err) : resolve());
      });
    }
    if (originalEnv.port === undefined) delete process.env.PORT;
    else process.env.PORT = originalEnv.port;
  });
  const fakeSupabase = {
    from: () => {
      fromCalls++;
      return {
        select() { return this; },
        update() { return this; },
        insert() { return this; },
        upsert() { return this; },
        delete() { return this; },
        eq() { return this; },
        in() { return this; },
        is() { return this; },
        neq() { return this; },
        or() { return this; },
        order() { return this; },
        limit() { return this; },
        single() { return Promise.resolve({ data: { id: "test-upload-batch" }, error: null }); },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve, reject) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        }
      };
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: "https://storage.invalid/test-image" } })
      })
    },
    rpc: async () => {
      rpcCalls++;
      return { data: [], error: null };
    }
  };

  const portReservation = http.createServer();
  await new Promise(resolve => portReservation.listen(0, "127.0.0.1", resolve));
  const port = portReservation.address().port;
  await new Promise((resolve, reject) => portReservation.close(err => err ? reject(err) : resolve()));

  const originalLoad = Module._load;
  const originalListen = express.application.listen;
  const originalSetInterval = global.setInterval;
  process.env.PORT = String(port);
  process.env.SUPABASE_URL = "https://supabase.invalid";
  process.env.SUPABASE_SERVICE_ROLE = "test-service-role";
  delete process.env.RPC_URL;
  delete process.env.PRIVATE_KEY;
  delete process.env.TOKEN_ADDRESS;
  Module._load = function(request, parent, isMain) {
    if (request === "@supabase/supabase-js") {
      return { createClient: () => fakeSupabase };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  express.application.listen = function() {
    app = this;
    return {};
  };
  global.setInterval = () => ({});

  try {
    serverModule = require("../server");
  } finally {
    Module._load = originalLoad;
    express.application.listen = originalListen;
    global.setInterval = originalSetInterval;
    for (const [name, value] of [
      ["SUPABASE_URL", originalEnv.supabaseUrl],
      ["SUPABASE_SERVICE_ROLE", originalEnv.supabaseRole],
      ["RPC_URL", originalEnv.rpcUrl],
      ["PRIVATE_KEY", originalEnv.privateKey],
      ["TOKEN_ADDRESS", originalEnv.tokenAddress]
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  await new Promise(resolve => setImmediate(resolve));
  fromCalls = 0;
  rpcCalls = 0;
  server = http.createServer(app);
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;

  for (const path of ["/api/execute-claim", "/api/claim-reward"]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "unused", email: "unused", walletAddress: "unused" })
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      success: false,
      error: "Payout redemption is temporarily disabled."
    });
  }
  assert.equal(fromCalls, 0);
  assert.equal(rpcCalls, 0);

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: process.env.ADMIN_SECRET_KEY })
  });
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();
  assert.equal(verifySessionToken(token, "admin", ADMIN_PURPOSE), true);

  const anonymousWakeResponse = await fetch(`${baseUrl}/api/public-wake`, { method: "POST" });
  assert.equal(anonymousWakeResponse.status, 503);
  assert.equal(rpcCalls, 0);

  const unauthorizedWakeResponse = await fetch(`${baseUrl}/api/admin/queue/wake`, {
    method: "POST",
    headers: { "x-admin-key": process.env.ADMIN_SECRET_KEY }
  });
  assert.equal(unauthorizedWakeResponse.status, 403);
  assert.equal(rpcCalls, 0);

  const adminWakeResponse = await fetch(`${baseUrl}/api/admin/queue/wake`, {
    method: "POST",
    headers: { "x-admin-key": token }
  });
  assert.equal(adminWakeResponse.status, 200);
  assert.equal((await adminWakeResponse.json()).success, true);
  assert.equal(rpcCalls, 1);

  const nativeFetch = global.fetch;
  let resolveUploadWakeCancelled;
  const uploadWakeCancelled = new Promise(resolve => {
    resolveUploadWakeCancelled = resolve;
  });
  global.fetch = async () => ({
    ok: true,
    status: 200,
    body: { cancel: async () => resolveUploadWakeCancelled() }
  });
  try {
    const uploadResponse = await nativeFetch(`${baseUrl}/api/upload-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "worker-test@example.invalid",
        taskType: "document",
        fileName: "test.jpg",
        imageBase64: "data:image/jpeg;base64,dGVzdA=="
      })
    });
    assert.equal(uploadResponse.status, 200);
    assert.equal((await uploadResponse.json()).success, true);
    await uploadWakeCancelled;
  } finally {
    global.fetch = nativeFetch;
  }
});

test("worker requests have a bounded default timeout and preserve explicit caller signals", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let defaultTimeoutDelay;
  let observedSignal;

  global.setTimeout = (callback, delay, ...args) => {
    if (delay === serverModule.WORKER_REQUEST_TIMEOUT_MS) {
      defaultTimeoutDelay = delay;
      return originalSetTimeout(callback, 1, ...args);
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.fetch = (_url, options) => new Promise((resolve, reject) => {
    observedSignal = options.signal;
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });

  try {
    await assert.rejects(serverModule.triggerUploadQueueWorker(), /Internal worker request timed out/);
    assert.equal(defaultTimeoutDelay, 30000);

    defaultTimeoutDelay = undefined;
    const callerController = new AbortController();
    const request = serverModule.triggerUploadQueueWorker(callerController.signal);
    assert.equal(observedSignal, callerController.signal);
    callerController.abort(new Error("Caller timeout"));
    await assert.rejects(request, /Caller timeout/);
    assert.equal(defaultTimeoutDelay, undefined);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("worker HTTP errors cancel response bodies and preserve status", async () => {
  const originalFetch = global.fetch;
  let cancelCalls = 0;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    body: { cancel: async () => { cancelCalls++; } }
  });

  try {
    await assert.rejects(
      serverModule.triggerUploadQueueWorker(),
      error => error.message === "Queue worker returned HTTP 503." && error.statusCode === 503
    );
    assert.equal(cancelCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin wake cancels successful bodies while polling continues to parse JSON", async (t) => {
  const originalFetch = global.fetch;
  const nativeFetch = originalFetch;
  const server = http.createServer(serverModule.app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let cancelCalls = 0;
  let workerResponse;
  global.fetch = async () => workerResponse;

  try {
    const adminToken = createAdminToken();
    workerResponse = {
      ok: true,
      status: 200,
      body: { cancel: async () => { cancelCalls++; } }
    };
    const wakeResponse = await nativeFetch(`${baseUrl}/api/admin/queue/wake`, {
      method: "POST",
      headers: { "x-admin-key": adminToken }
    });
    assert.equal(wakeResponse.status, 200);
    assert.equal(cancelCalls, 1);

    workerResponse = {
      ok: false,
      status: 503,
      body: { cancel: async () => { cancelCalls++; } }
    };
    const failedWakeResponse = await nativeFetch(`${baseUrl}/api/admin/queue/wake`, {
      method: "POST",
      headers: { "x-admin-key": adminToken }
    });
    assert.equal(failedWakeResponse.status, 503);
    assert.equal(cancelCalls, 2);

    let jsonCalls = 0;
    workerResponse = {
      ok: true,
      status: 200,
      json: async () => {
        jsonCalls++;
        return { processed: 0 };
      }
    };
    await serverModule.executeSafeQueuePass();
    assert.equal(jsonCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("90-second poll timeout errors are handled and queue lock is released", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalConsoleError = console.error;
  let timeoutDelay;
  let fetchCalls = 0;
  let loggedTimeouts = 0;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 90000) {
      timeoutDelay = delay;
      return originalSetTimeout(callback, 1, ...args);
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.fetch = (_url, options) => {
    fetchCalls++;
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  console.error = (...args) => {
    if (args[0] === "[QUEUE HEARTBEAT ERROR]") loggedTimeouts++;
  };

  try {
    await serverModule.executeSafeQueuePass();
    await serverModule.executeSafeQueuePass();
    assert.equal(timeoutDelay, 90000);
    assert.equal(fetchCalls, 2);
    assert.equal(loggedTimeouts, 2);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    console.error = originalConsoleError;
  }
});

test("default-timeout upload poll errors release the worker lock", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalConsoleError = console.error;
  let timeoutDelay;
  let fetchCalls = 0;
  let loggedTimeouts = 0;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === serverModule.WORKER_REQUEST_TIMEOUT_MS) {
      timeoutDelay = delay;
      return originalSetTimeout(callback, 1, ...args);
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.fetch = (_url, options) => {
    fetchCalls++;
    return new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  };
  console.error = (...args) => {
    if (args[0] === "[WORKER ERROR] Background loop failed:") loggedTimeouts++;
  };

  try {
    await serverModule.runUploadQueuePoll();
    await serverModule.runUploadQueuePoll();
    assert.equal(timeoutDelay, serverModule.WORKER_REQUEST_TIMEOUT_MS);
    assert.equal(fetchCalls, 2);
    assert.equal(loggedTimeouts, 2);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    console.error = originalConsoleError;
  }
});

test.after(() => {
  if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET_KEY;
  else process.env.ADMIN_SECRET_KEY = previousAdminSecret;
  if (previousSessionSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
  else process.env.ADMIN_SESSION_SECRET = previousSessionSecret;
});
