const crypto = require('crypto');
const { maskEmail } = require('./passwordReset');

const CODE_LENGTH = 6;

function generateNumericCode() {
  const min = 10 ** (CODE_LENGTH - 1);
  const max = 10 ** CODE_LENGTH - 1;
  return String(crypto.randomInt(min, max + 1));
}

function getEmailVerifySecret() {
  return (
    process.env.EMAIL_VERIFY_SECRET ||
    process.env.PASSWORD_RESET_SECRET ||
    process.env.JWT_SECRET ||
    'your-secret-key'
  );
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
