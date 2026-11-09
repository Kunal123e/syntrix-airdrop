function getUserStoragePathSegment(email) {
  return Buffer.from(email.trim().toLowerCase(), "utf8").toString("base64url");
}

module.exports = { getUserStoragePathSegment };
