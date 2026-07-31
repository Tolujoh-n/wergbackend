const crypto = require('crypto');

/**
 * Resolve JWT signing secret. Never fall back to a public default.
 * Set JWT_SECRET in backend/.env (long random string).
 */
function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret || secret === 'your-secret-key' || secret === 'replace-with-strong-random') {
    const err = new Error(
      'JWT_SECRET is missing or insecure. Set a long random JWT_SECRET in backend/.env and restart the server.'
    );
    err.code = 'JWT_SECRET_MISSING';
    throw err;
  }
  if (secret.length < 32) {
    const err = new Error(
      'JWT_SECRET is too short. Use at least 32 characters (e.g. openssl rand -hex 32).'
    );
    err.code = 'JWT_SECRET_WEAK';
    throw err;
  }
  return secret;
}

function assertJwtSecretConfigured() {
  getJwtSecret();
}

function generateSecureSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = {
  getJwtSecret,
  assertJwtSecretConfigured,
  generateSecureSecret,
};
