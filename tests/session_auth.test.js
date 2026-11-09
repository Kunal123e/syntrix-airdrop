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

test("process-queue preserves a failed upload record when its storage asset is missing", async (t) => {
  const originalFetch = global.fetch;
  const originalDocumentKey = process.env.GEMINI_DOCUMENT_KEY_1;
  const updates = [];
  let deleted = false;
  process.env.GEMINI_DOCUMENT_KEY_1 = "test-document-key";

  const job = {
    id: "missing-asset-job",
    status: "QUEUED",
    user_email: "user@example.test",
    task_type: "document",
    storage_url: "https://storage.invalid/storage/v1/object/public/verified_assets/missing.jpg",
    file_name: "missing.jpg",
    file_hash: "missing-hash",
    retry_count: 0,
    max_retries: 3,
    batch_id: "missing-asset-batch",
    content_tags: [],
    assigned_task: null
  };
  const app = express();
  app.locals.supabase = {
    rpc: async () => ({ data: [job], error: null }),
    from(table) {
      let operation;
      let selected = false;
      const builder = {
        select() {
          selected = true;
          return this;
        },
        update(values) {
          operation = { type: "update", values };
          if (table === "upload_jobs") updates.push(values);
          return this;
        },
        delete() {
          deleted = true;
          operation = { type: "delete" };
          return this;
        },
        eq() { return this; },
        or() { return this; },
        then(resolve, reject) {
          let result = { data: [], error: null };
          if (table === "upload_jobs" && operation && operation.values.status === "PROCESSING" && selected) {
            result = { data: [{ id: job.id }], error: null };
          } else if (table === "upload_jobs" && selected) {
            result = { data: [{ status: "FAILED", user_email: job.user_email }], error: null };
          }
          return Promise.resolve(result).then(resolve, reject);
        },
        single() {
          return Promise.resolve({ data: { status: "PROCESSING" }, error: null });
        }
      };
      return builder;
    },
    storage: {
      from() {
        return {
          download: async () => ({
            data: null,
            error: { message: "Object not found", statusCode: 404 }
          })
        };
      }
    }
  };
  global.fetch = async () => ({ ok: false, status: 404 });
  app.use("/api/process-queue", processQueueRouter);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    global.fetch = originalFetch;
    if (originalDocumentKey === undefined) delete process.env.GEMINI_DOCUMENT_KEY_1;
    else process.env.GEMINI_DOCUMENT_KEY_1 = originalDocumentKey;
    await new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    });
  });

  const response = await originalFetch(`http://127.0.0.1:${server.address().port}/api/process-queue`, {
    method: "POST",
    headers: { "x-admin-key": createWorkerToken() }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results[0].result, "FAILED");
  assert.equal(deleted, false);

  const failureUpdate = updates.find(update => update.status === "FAILED");
  assert.ok(failureUpdate);
  assert.equal(failureUpdate.error_code, "ASSET_NOT_FOUND");
  assert.match(failureUpdate.reason, /HTTP 404: Storage object does not exist/);
  assert.ok(Number.isFinite(Date.parse(failureUpdate.processed_at)));
  assert.equal(failureUpdate.retry_count, 1);
  assert.equal(failureUpdate.assigned_key, null);
  assert.equal(failureUpdate.locked_by, null);
  assert.equal(failureUpdate.lease_expires_at, null);
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

test("worker requests have a bounded internal timeout and caller abort does not cancel a shared pass", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let defaultTimeoutDelay;
  let observedSignal;
  let fetchCalls = 0;
  let finishThirdRequest;

  global.setTimeout = (callback, delay, ...args) => {
    if (delay === serverModule.WORKER_REQUEST_TIMEOUT_MS) {
      defaultTimeoutDelay = delay;
      return originalSetTimeout(callback, fetchCalls === 0 ? 1 : delay, ...args);
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.fetch = (_url, options) => new Promise((resolve, reject) => {
    fetchCalls++;
    observedSignal = options.signal;
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    if (fetchCalls === 1) {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    } else if (fetchCalls === 2) {
      resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ processed: 0 })
      });
    } else {
      finishThirdRequest = resolve;
    }
  });

  try {
    const retriedResponse = await serverModule.triggerUploadQueueWorker();
    assert.equal(retriedResponse.status, 200);
    assert.equal(defaultTimeoutDelay, 30000);
    assert.equal(fetchCalls, 2, "an ambiguous timed-out request is serialized with its retry");

    defaultTimeoutDelay = undefined;
    const callerController = new AbortController();
    const request = serverModule.triggerUploadQueueWorker(callerController.signal);
    assert.notEqual(observedSignal, callerController.signal);
    callerController.abort(new Error("Caller timeout"));
    await assert.rejects(request, /Caller timeout/);
    assert.equal(observedSignal.aborted, false, "aborting one waiter must not abort the shared worker pass");
    finishThirdRequest({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ processed: 0 })
    });
    await new Promise(resolve => setImmediate(resolve));
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

test("overlapping worker triggers coalesce and preserve a retrigger during each active pass", async () => {
  const originalFetch = global.fetch;
  const pendingRequests = [];
  const requestUrls = [];
  let fetchCalls = 0;
  let canceledBodies = 0;

  function makeResponse(status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => status === 429
        ? JSON.stringify({ message: "Queue processor already active on server." })
        : JSON.stringify({ processed: 0 }),
      body: { cancel: async () => { canceledBodies++; } },
      clone() {
        return makeResponse(status);
      }
    };
  }

  global.fetch = url => new Promise(resolve => {
    fetchCalls++;
    requestUrls.push(url);
    pendingRequests.push(resolve);
  });

  async function waitForFetchCalls(expected) {
    for (let attempt = 0; attempt < 500 && fetchCalls < expected; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(fetchCalls, expected);
  }

  try {
    const requests = [serverModule.triggerUploadQueueWorker()];
    await waitForFetchCalls(1);
    requests.push(serverModule.triggerUploadQueueWorker(), serverModule.triggerUploadQueueWorker());
    assert.equal(fetchCalls, 1, "overlapping callers must not start concurrent worker requests");

    pendingRequests[0](makeResponse(429));
    await waitForFetchCalls(2);
    requests.push(serverModule.triggerUploadQueueWorker());
    pendingRequests[1](makeResponse());
    await waitForFetchCalls(3);
    pendingRequests[2](makeResponse());

    const responses = await Promise.all(requests);
    assert.equal(fetchCalls, 3, "busy responses retry serially and concurrent triggers coalesce to one follow-up");
    assert.ok(requestUrls.every(url => /^http:\/\/127\.0\.0\.1:\d+\/api\/process-queue$/.test(url)));
    assert.equal(canceledBodies, 0, "response bodies are buffered instead of prematurely canceled");
    assert.ok(responses.every(response => response.status === 200));
    assert.notEqual(responses[0], responses[1], "each caller receives an independent response");
    assert.deepEqual(await Promise.all(responses.map(response => response.json())), [
      { processed: 0 },
      { processed: 0 },
      { processed: 0 },
      { processed: 0 }
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a worker-busy 429 is retried even when no later trigger is pending", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ message: "Queue processor already active on server." })
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ processed: 0 })
    };
  };

  try {
    const response = await serverModule.triggerUploadQueueWorker();
    assert.equal(response.status, 200);
    assert.equal(fetchCalls, 2, "busy guard response is retried until the active pass completes");
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

test("heartbeat and poll triggers serialize and rerun when a pass is already active", async () => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  let fetchCalls = 0;
  const pendingRequests = [];
  let loggedErrors = 0;
  global.fetch = (_url, options) => {
    fetchCalls++;
    assert.ok(options.signal, "worker requests retain their own bounded request signal");
    return new Promise(resolve => { pendingRequests.push(resolve); });
  };
  console.error = (...args) => {
    if (args[0] === "[QUEUE HEARTBEAT ERROR]") loggedErrors++;
  };

  try {
    const heartbeatPass = serverModule.executeSafeQueuePass();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCalls, 1);
    const pollPass = serverModule.runUploadQueuePoll();
    pendingRequests[0]({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ processed: 0 })
    });
    for (let attempt = 0; attempt < 20 && fetchCalls < 2; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(fetchCalls, 2);
    pendingRequests[1]({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ processed: 0 })
    });
    await Promise.all([heartbeatPass, pollPass]);
    assert.equal(loggedErrors, 0);
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("default request timeout retries serially until the worker responds", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  let timeoutDelay;
  let fetchCalls = 0;
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === serverModule.WORKER_REQUEST_TIMEOUT_MS) {
      timeoutDelay = delay;
      return originalSetTimeout(callback, fetchCalls === 0 ? 1 : delay, ...args);
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.fetch = (_url, options) => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ processed: 0 })
    });
  };

  try {
    await serverModule.runUploadQueuePoll();
    assert.equal(timeoutDelay, serverModule.WORKER_REQUEST_TIMEOUT_MS);
    assert.equal(fetchCalls, 2);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
});

test.after(() => {
  if (previousAdminSecret === undefined) delete process.env.ADMIN_SECRET_KEY;
  else process.env.ADMIN_SECRET_KEY = previousAdminSecret;
  if (previousSessionSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
  else process.env.ADMIN_SESSION_SECRET = previousSessionSecret;
});
