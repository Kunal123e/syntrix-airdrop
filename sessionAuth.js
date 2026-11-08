const crypto = require("crypto");

const ADMIN_PURPOSE = "syntrix-admin-session";
const WORKER_PURPOSE = "syntrix-upload-queue";
const ADMIN_TTL_SECONDS = 15 * 60;
const WORKER_TTL_SECONDS = 60;
const MAX_TOKEN_LENGTH = 2048;

function getSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  const adminPassword = process.env.ADMIN_SECRET_KEY;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return null;
  if (typeof adminPassword !== "string" || secret === adminPassword) return null;
  return Buffer.from(secret, "utf8");
}

function isSessionAuthConfigured() {
  return getSessionSecret() !== null;
}

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createToken(role, purpose, ttlSeconds) {
  const secret = getSessionSecret();
  if (!secret) throw new Error("Session authentication is not configured.");

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    role,
    purpose,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function createAdminToken() {
  return createToken("admin", ADMIN_PURPOSE, ADMIN_TTL_SECONDS);
}

function createWorkerToken() {
  return createToken("worker", WORKER_PURPOSE, WORKER_TTL_SECONDS);
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) return null;
  return decoded;
}

function verifySessionToken(token, expectedRole, expectedPurpose) {
  const secret = getSessionSecret();
  if (!secret || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encodedPayload, encodedSignature] = parts;
  const payloadBuffer = decodeBase64Url(encodedPayload);
  const signature = decodeBase64Url(encodedSignature);
  if (!payloadBuffer || !signature || signature.length !== 32) return false;

  const expectedSignature = crypto.createHmac("sha256", secret).update(encodedPayload).digest();
  if (!crypto.timingSafeEqual(signature, expectedSignature)) return false;

  let claims;
  try {
    const payloadText = payloadBuffer.toString("utf8");
    if (!Buffer.from(payloadText, "utf8").equals(payloadBuffer)) return false;
    claims = JSON.parse(payloadText);
  } catch {
    return false;
  }

  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return false;
  const fields = Object.keys(claims).sort();
  if (fields.length !== 4 || fields.join(",") !== "exp,iat,purpose,role") return false;
  if (claims.role !== expectedRole || claims.purpose !== expectedPurpose) return false;
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) return false;

  const ttl = expectedRole === "admin" && expectedPurpose === ADMIN_PURPOSE
    ? ADMIN_TTL_SECONDS
    : expectedRole === "worker" && expectedPurpose === WORKER_PURPOSE
      ? WORKER_TTL_SECONDS
      : 0;
  const now = Math.floor(Date.now() / 1000);
  if (ttl === 0 || claims.iat > now + 30 || claims.exp <= now) return false;
  if (claims.exp <= claims.iat || claims.exp - claims.iat > ttl) return false;
  return true;
}

module.exports = {
  ADMIN_PURPOSE,
  WORKER_PURPOSE,
  createAdminToken,
  createWorkerToken,
  isSessionAuthConfigured,
  safeStringEqual,
  verifySessionToken
};
