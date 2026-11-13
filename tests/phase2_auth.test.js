const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const http = require("node:http");
const {
  applyRateLimitResponse,
  assertSessionEmail,
  createUserSessionToken,
  getRateKeys,
  getSessionHash,
  getTrustedClientIp,
  getUserSessionHmacSecret,
  issueOtpWithRpc,
  requireUserSession,
  revokeUserSession,
  verifyOtpWithRpc
} = require("../phase2Auth");

const originalEnv = {
  rateSecret: process.env.OTP_RATE_LIMIT_HMAC_SECRET,
  sessionSecret: process.env.USER_SESSION_HMAC_SECRET,
  proxyHops: process.env.TRUSTED_PROXY_HOPS,
  enforce: process.env.PHASE2_AUTH_ENFORCE_SESSIONS
};

function restoreEnv() {
  for (const [name, value] of [
    ["OTP_RATE_LIMIT_HMAC_SECRET", originalEnv.rateSecret],
    ["USER_SESSION_HMAC_SECRET", originalEnv.sessionSecret],
    ["TRUSTED_PROXY_HOPS", originalEnv.proxyHops],
    ["PHASE2_AUTH_ENFORCE_SESSIONS", originalEnv.enforce]
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("[UNIT] trusted proxy handling rejects missing/invalid configuration and arbitrary forwarding", () => {
  try {
    delete process.env.TRUSTED_PROXY_HOPS;
    assert.equal(getTrustedClientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), null);

    process.env.TRUSTED_PROXY_HOPS = "1";
    assert.equal(getTrustedClientIp({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "198.51.100.10" }
    }), "198.51.100.10");
    assert.equal(getTrustedClientIp({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "not-an-ip" }
    }), null);

    process.env.TRUSTED_PROXY_HOPS = "bad";
    assert.equal(getTrustedClientIp({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), null);
  } finally {
    restoreEnv();
  }
});

test("[UNIT] rate keys are HMAC-derived and unavailable without trusted IP configuration", () => {
  try {
    process.env.OTP_RATE_LIMIT_HMAC_SECRET = "r".repeat(64);
    delete process.env.TRUSTED_PROXY_HOPS;
    assert.equal(getRateKeys("User@Example.test", { socket: { remoteAddress: "127.0.0.1" }, headers: {} }), null);

    process.env.TRUSTED_PROXY_HOPS = "0";
    const keys = getRateKeys("User@Example.test", {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {}
    });
    assert.match(keys.emailKey, /^[a-f0-9]{64}$/);
    assert.match(keys.ipKey, /^[a-f0-9]{64}$/);
    assert.notEqual(keys.emailKey, keys.ipKey);
  } finally {
    restoreEnv();
  }
});

test("[UNIT] user sessions use opaque random tokens and a separate configured HMAC secret", () => {
  try {
    process.env.USER_SESSION_HMAC_SECRET = "s".repeat(64);
    process.env.OTP_HMAC_SECRET = "o".repeat(64);
    const token = createUserSessionToken();
    assert.match(token, /^[A-Za-z0-9_-]{20,}$/);
    assert.match(getSessionHash(token), /^[a-f0-9]{64}$/);
    assert.equal(getUserSessionHmacSecret(), process.env.USER_SESSION_HMAC_SECRET);
    assert.notEqual(token, getSessionHash(token));
  } finally {
    delete process.env.OTP_HMAC_SECRET;
    restoreEnv();
  }
});

test("[SIMULATED] RPC wrappers pass explicit prepared-contract arguments and preserve statuses", async () => {
  const calls = [];
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ status: "accepted" }], error: null };
    }
  };
  const req = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };

  try {
    process.env.OTP_RATE_LIMIT_HMAC_SECRET = "r".repeat(64);
    process.env.USER_SESSION_HMAC_SECRET = "s".repeat(64);
    process.env.TRUSTED_PROXY_HOPS = "0";
    await issueOtpWithRpc(supabase, "User@Example.test", req, "a".repeat(64), Date.now() + 300000);
    await verifyOtpWithRpc(supabase, "User@Example.test", req, "b".repeat(64), "c".repeat(64), Date.now() + 43200000);
    await revokeUserSession(supabase, "opaque-session-token-for-tests");
    assert.deepEqual(calls.map(call => call.name), [
      "syntrix_auth_issue_otp",
      "syntrix_auth_verify_otp",
      "syntrix_auth_revoke_session"
    ]);
    assert.equal(calls[0].args.p_email_principal, "user@example.test");
    assert.match(calls[0].args.p_email_key, /^[a-f0-9]{64}$/);
    assert.match(calls[1].args.p_session_hash, /^[a-f0-9]{64}$/);
  } finally {
    restoreEnv();
  }
});

test("[SIMULATED] session middleware validates the RPC principal and rejects mismatched caller email", async () => {
  const supabase = {
    rpc: async (name, args) => {
      assert.equal(name, "syntrix_auth_validate_session");
      assert.match(args.p_session_hash, /^[a-f0-9]{64}$/);
      return { data: [{ status: "active", email_principal: "user@example.test" }], error: null };
    }
  };
  const app = express();
  app.use(express.json());
  process.env.USER_SESSION_HMAC_SECRET = "s".repeat(64);
  process.env.PHASE2_AUTH_ENFORCE_SESSIONS = "true";
  app.get("/private", requireUserSession(supabase), (req, res) => {
    res.status(assertSessionEmail(req, req.query.email) ? 200 : 403).json({ ok: true });
  });
  const server = http.createServer(app);

  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const token = createUserSessionToken();
    const ownerResponse = await fetch(`${baseUrl}/private?email=user%40example.test`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(ownerResponse.status, 200);
    const otherResponse = await fetch(`${baseUrl}/private?email=other%40example.test`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(otherResponse.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    restoreEnv();
  }
});

test("[UNIT] rate-limit responses include a clear Retry-After without account-specific data", () => {
  const response = {
    headers: {},
    set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  applyRateLimitResponse(response, { retry_after_seconds: 42 });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["Retry-After"], "42");
  assert.deepEqual(response.body, {
    error: "Too many requests. Please retry later.",
    retryAfter: 42
  });
});

test("[SIMULATED] failed-attempt policy blocks the sixth attempt without exceeding five", () => {
  let failures = 0;
  const verifyWrongCode = () => {
    if (failures >= 5) return { status: "rate_limited" };
    failures++;
    return { status: "invalid" };
  };

  assert.equal(verifyWrongCode().status, "invalid");
  assert.equal(verifyWrongCode().status, "invalid");
  assert.equal(verifyWrongCode().status, "invalid");
  assert.equal(verifyWrongCode().status, "invalid");
  assert.equal(verifyWrongCode().status, "invalid");
  assert.equal(failures, 5);
  assert.equal(verifyWrongCode().status, "rate_limited");
  assert.equal(failures, 5);
});

test("[SIMULATED] serialized concurrent incorrect requests cannot exceed five failures", async () => {
  let failures = 0;
  let lock = Promise.resolve();
  const verifyWrongCode = () => {
    const operation = lock.then(() => {
      if (failures >= 5) return { status: "rate_limited" };
      failures++;
      return { status: "invalid" };
    });
    lock = operation.catch(() => undefined);
    return operation;
  };

  const results = await Promise.all(Array.from({ length: 20 }, verifyWrongCode));
  assert.equal(results.filter(result => result.status === "invalid").length, 5);
  assert.equal(results.filter(result => result.status === "rate_limited").length, 15);
  assert.equal(failures, 5);
});

test("[SIMULATED] migration is fail-fast and guards the sixth failed OTP attempt", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "sql", "phase2_auth_migration.sql"), "utf8");
  const preflight = fs.readFileSync(path.join(__dirname, "..", "sql", "phase2_auth_preflight.sql"), "utf8");
  const staging = fs.readFileSync(path.join(__dirname, "..", "sql", "phase2_auth_staging.sql"), "utf8");
  const rollback = fs.readFileSync(path.join(__dirname, "..", "sql", "phase2_auth_rollback.sql"), "utf8");

  assert.match(migration, /^begin;\s/m);
  assert.match(migration, /raise exception 'Phase 2 preflight failed:/);
  assert.match(migration, /syntrix_auth_otp_active_email_idx/);
  assert.match(migration, /p\.proname in \(/);
  assert.match(migration, /create table public\.syntrix_auth_otp_challenges/);
  assert.doesNotMatch(migration, /create table if not exists/i);
  assert.doesNotMatch(migration, /create (or replace|or replace function)/i);
  assert.match(migration, /v_failed_count >= 5 or v_challenge\.failed_attempts >= 5/);
  assert.match(migration, /failed_attempts < 5/);
  assert.match(migration, /purpose text not null check \(purpose = 'syntrix-user-session'\)/);
  assert.match(migration, /audience text not null check \(audience = 'syntrix-api'\)/);
  assert.match(migration, /update public\.syntrix_auth_sessions/);
  assert.match(migration, /returning email_principal into v_email/);
  assert.match(migration, /create function public\.syntrix_auth_activate_otp/);
  assert.match(migration, /create function public\.syntrix_auth_invalidate_otp/);
  assert.match(migration, /create function public\.syntrix_auth_cleanup/);
  assert.doesNotMatch(migration, /delete from public\.syntrix_auth_rate_events where occurred_at < v_now/);
  assert.match(migration, /commit;\s*$/);
  assert.match(preflight, /select current_database\(\)/);
  assert.match(preflight, /pg_catalog\.pg_roles/);
  assert.match(staging, /standalone Supabase SQL Editor script/);
  assert.match(staging, /begin;/);
  assert.match(rollback, /DO NOT RUN UNLESS ROLLBACK IS EXPLICITLY APPROVED/);
});
