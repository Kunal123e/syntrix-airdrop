const crypto = require("crypto");
const net = require("net");

const OTP_RATE_LIMIT_HMAC_SECRET_ENV = "OTP_RATE_LIMIT_HMAC_SECRET";
const USER_SESSION_HMAC_SECRET_ENV = "USER_SESSION_HMAC_SECRET";
const TRUSTED_PROXY_HOPS_ENV = "TRUSTED_PROXY_HOPS";
const PHASE2_AUTH_RPC_ENABLED_ENV = "PHASE2_AUTH_RPC_ENABLED";
const PHASE2_AUTH_ENFORCE_SESSIONS_ENV = "PHASE2_AUTH_ENFORCE_SESSIONS";
const USER_SESSION_TTL_SECONDS = 12 * 60 * 60;
const USER_SESSION_PURPOSE = "syntrix-user-session";
const USER_SESSION_AUDIENCE = "syntrix-api";

function getSecret(name, forbidden) {
  const secret = process.env[name];
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return null;
  if (forbidden.some(value => typeof value === "string" && secret === value)) return null;
  return secret;
}

function getRateLimitHmacSecret() {
  return getSecret(OTP_RATE_LIMIT_HMAC_SECRET_ENV, [
    process.env.OTP_HMAC_SECRET,
    process.env.ADMIN_SECRET_KEY,
    process.env.ADMIN_SESSION_SECRET,
    process.env.USER_SESSION_HMAC_SECRET
  ]);
}

function getUserSessionHmacSecret() {
  return getSecret(USER_SESSION_HMAC_SECRET_ENV, [
    process.env.OTP_HMAC_SECRET,
    process.env.ADMIN_SECRET_KEY,
    process.env.ADMIN_SESSION_SECRET,
    process.env.OTP_RATE_LIMIT_HMAC_SECRET
  ]);
}

function isPhase2RpcEnabled() {
  return process.env[PHASE2_AUTH_RPC_ENABLED_ENV] === "true";
}

function isSessionEnforcementEnabled() {
  return process.env[PHASE2_AUTH_ENFORCE_SESSIONS_ENV] === "true";
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function hmacKey(value, secret) {
  return crypto.createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function createUserSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getSessionHash(token) {
  const secret = getUserSessionHmacSecret();
  if (!secret || typeof token !== "string" || token.length < 20 || token.length > 256) return null;
  return hmacKey(token, secret);
}

function parseTrustedProxyHops() {
  const raw = process.env[TRUSTED_PROXY_HOPS_ENV];
  if (!/^(0|[1-9]\d*)$/.test(raw || "")) return null;
  const hops = Number(raw);
  return Number.isSafeInteger(hops) && hops <= 10 ? hops : null;
}

function getTrustedClientIp(req) {
  const hops = parseTrustedProxyHops();
  if (hops === null) return null;

  if (hops === 0) {
    const directIp = req.socket && req.socket.remoteAddress;
    return directIp && net.isIP(directIp) ? directIp : null;
  }

  const forwarded = req.headers["x-forwarded-for"];
  const addresses = typeof forwarded === "string"
    ? forwarded.split(",").map(value => value.trim()).filter(Boolean)
    : [];
  if (addresses.length < hops) return null;
  const candidate = addresses[addresses.length - hops];
  return net.isIP(candidate) ? candidate : null;
}

function getRateKeys(email, req) {
  const secret = getRateLimitHmacSecret();
  const ip = getTrustedClientIp(req);
  if (!secret || !ip) return null;
  return {
    emailKey: hmacKey(normalizeEmail(email), secret),
    ipKey: hmacKey(ip, secret)
  };
}

function toRpcResult(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data && typeof data === "object" ? data : null;
}

function retryAfterSeconds(result) {
  const value = Number(result && result.retry_after_seconds);
  return Number.isInteger(value) && value > 0 ? value : 60;
}

function applyRateLimitResponse(res, result) {
  const retryAfter = retryAfterSeconds(result);
  res.set("Retry-After", String(retryAfter));
  return res.status(429).json({
    error: "Too many requests. Please retry later.",
    retryAfter
  });
}

async function callRpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return toRpcResult(data);
}

async function issueOtpWithRpc(supabase, email, req, otpDigest, expiresAt) {
  const keys = getRateKeys(email, req);
  if (!keys) return { status: "ip_configuration_error" };
  return callRpc(supabase, "syntrix_auth_issue_otp", {
    p_email_principal: normalizeEmail(email),
    p_email_key: keys.emailKey,
    p_ip_key: keys.ipKey,
    p_otp_digest: otpDigest,
    p_expires_at: new Date(expiresAt).toISOString()
  });
}

async function activateOtpWithRpc(supabase, challengeId) {
  return callRpc(supabase, "syntrix_auth_activate_otp", {
    p_challenge_id: challengeId
  });
}

async function invalidateOtpWithRpc(supabase, challengeId) {
  return callRpc(supabase, "syntrix_auth_invalidate_otp", {
    p_challenge_id: challengeId
  });
}

async function verifyOtpWithRpc(supabase, email, req, otpDigest, sessionHash, sessionExpiresAt) {
  const keys = getRateKeys(email, req);
  if (!keys) return { status: "ip_configuration_error" };
  return callRpc(supabase, "syntrix_auth_verify_otp", {
    p_email_principal: normalizeEmail(email),
    p_email_key: keys.emailKey,
    p_ip_key: keys.ipKey,
    p_otp_digest: otpDigest,
    p_session_hash: sessionHash,
    p_session_expires_at: new Date(sessionExpiresAt).toISOString(),
    p_session_purpose: USER_SESSION_PURPOSE,
    p_session_audience: USER_SESSION_AUDIENCE
  });
}

async function validateUserSession(supabase, token) {
  const sessionHash = getSessionHash(token);
  if (!sessionHash) return null;
  return callRpc(supabase, "syntrix_auth_validate_session", {
    p_session_hash: sessionHash,
    p_session_purpose: USER_SESSION_PURPOSE,
    p_session_audience: USER_SESSION_AUDIENCE
  });
}

async function revokeUserSession(supabase, token) {
  const sessionHash = getSessionHash(token);
  if (!sessionHash) return null;
  return callRpc(supabase, "syntrix_auth_revoke_session", {
    p_session_hash: sessionHash
  });
}

function requireUserSession(supabase) {
  return async function userSessionMiddleware(req, res, next) {
    if (!isSessionEnforcementEnabled()) return next();
    const authorization = req.headers.authorization || "";
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,256})$/.exec(authorization);
    if (!match || !getUserSessionHmacSecret()) {
      return res.status(401).json({ success: false, error: "Authenticated session required." });
    }

    try {
      const session = await validateUserSession(supabase, match[1]);
      if (!session || session.status !== "active" || typeof session.email_principal !== "string") {
        return res.status(401).json({ success: false, error: "Authenticated session required." });
      }
      req.userSession = { email: session.email_principal };
      return next();
    } catch (error) {
      return res.status(503).json({ success: false, error: "Authenticated session service unavailable." });
    }
  };
}

function assertSessionEmail(req, suppliedEmail) {
  if (!isSessionEnforcementEnabled()) return true;
  return normalizeEmail(suppliedEmail) === normalizeEmail(req.userSession && req.userSession.email);
}

module.exports = {
  PHASE2_AUTH_RPC_ENABLED_ENV,
  PHASE2_AUTH_ENFORCE_SESSIONS_ENV,
  OTP_RATE_LIMIT_HMAC_SECRET_ENV,
  TRUSTED_PROXY_HOPS_ENV,
  USER_SESSION_HMAC_SECRET_ENV,
  USER_SESSION_TTL_SECONDS,
  USER_SESSION_PURPOSE,
  USER_SESSION_AUDIENCE,
  applyRateLimitResponse,
  assertSessionEmail,
  createUserSessionToken,
  getRateKeys,
  getSessionHash,
  getTrustedClientIp,
  getUserSessionHmacSecret,
  isPhase2RpcEnabled,
  isSessionEnforcementEnabled,
  issueOtpWithRpc,
  activateOtpWithRpc,
  invalidateOtpWithRpc,
  normalizeEmail,
  requireUserSession,
  revokeUserSession,
  retryAfterSeconds,
  verifyOtpWithRpc
};
