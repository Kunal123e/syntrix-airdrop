const crypto = require("crypto");

function getOtpHmacSecret() {
  const secret = process.env.OTP_HMAC_SECRET;
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return null;
  if (secret === process.env.ADMIN_SECRET_KEY || secret === process.env.ADMIN_SESSION_SECRET) return null;
  return secret;
}

function createOtpCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function createOtpDigest(email, otp, secret) {
  return crypto.createHmac("sha256", secret)
    .update(`${email}\n${otp}`, "utf8")
    .digest("hex");
}

function createOtpRecord(email, otp, expires, secret) {
  return {
    digest: createOtpDigest(email, otp, secret),
    expires
  };
}

function safeOtpDigestEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

module.exports = {
  createOtpCode,
  createOtpDigest,
  createOtpRecord,
  getOtpHmacSecret,
  safeOtpDigestEqual
};
