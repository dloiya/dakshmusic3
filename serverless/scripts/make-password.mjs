import crypto from "node:crypto";

const password = process.argv[2];
if (!password) {
  console.error('Usage: node make-password.mjs "your-password"');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
// Must match worker.js's PBKDF2 call. Cloudflare Workers' crypto.subtle
// caps PBKDF2 at 100000 iterations, so we use that here too.
const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");

console.log("PASSWORD_SALT=" + salt.toString("base64url"));
console.log("PASSWORD_HASH=" + hash.toString("base64url"));
