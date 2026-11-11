'use strict';

const crypto = require('node:crypto');

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), useSalt, 64).toString('hex');
  return { salt: useSalt, hash };
}

function verifyPassword(password, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  try {
    const hash = crypto.scryptSync(String(password), stored.salt, 64);
    const expected = Buffer.from(stored.hash, 'hex');
    return expected.length === hash.length && crypto.timingSafeEqual(expected, hash);
  } catch {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomStreamKey() {
  return 'r42_' + crypto.randomBytes(18).toString('base64url');
}

function randomPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

module.exports = {
  hashPassword,
  verifyPassword,
  sha256,
  randomToken,
  randomStreamKey,
  randomPassword
};
