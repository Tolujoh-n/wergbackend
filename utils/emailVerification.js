const crypto = require('crypto');
const { maskEmail } = require('./passwordReset');

const CODE_LENGTH = 6;

function generateNumericCode() {
  const min = 10 ** (CODE_LENGTH - 1);
  const max = 10 ** CODE_LENGTH - 1;
  return String(crypto.randomInt(min, max + 1));
}

function getEmailVerifySecret() {
  if (process.env.EMAIL_VERIFY_SECRET && String(process.env.EMAIL_VERIFY_SECRET).trim()) {
    return String(process.env.EMAIL_VERIFY_SECRET).trim();
  }
  if (process.env.PASSWORD_RESET_SECRET && String(process.env.PASSWORD_RESET_SECRET).trim()) {
    return String(process.env.PASSWORD_RESET_SECRET).trim();
  }
  const { getJwtSecret } = require('./jwtSecret');
  return getJwtSecret();
}

function hashEmailVerifyCode(code) {
  const secret = getEmailVerifySecret();
  return crypto
    .createHash('sha256')
    .update(`free-play-email-verify:${code}:${secret}`)
    .digest('hex');
}

module.exports = {
  generateNumericCode,
  hashEmailVerifyCode,
  maskEmail,
  CODE_LENGTH,
};
