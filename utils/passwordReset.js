const crypto = require('crypto');

const CODE_LENGTH = 6;

function generateNumericCode() {
  const min = 10 ** (CODE_LENGTH - 1);
  const max = 10 ** CODE_LENGTH - 1;
  return String(crypto.randomInt(min, max + 1));
}

function getResetSecret() {
  return process.env.PASSWORD_RESET_SECRET || process.env.JWT_SECRET || 'your-secret-key';
}

function hashResetCode(code) {
  const secret = getResetSecret();
  return crypto.createHash('sha256').update(`${code}:${secret}`).digest('hex');
}

function buildPasswordResetSmsBody({ appName, code, minutesValid }) {
  const product = appName || 'WeRgame';
  const validity = minutesValid || 10;
  return `${product}: Your password reset code is ${code}. It expires in ${validity} minutes. Do not share this code.`;
}

function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at < 1) return '•••';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return `${local[0] || ''}•${domain}`;
  return `${local[0]}•••${local.slice(-1)}${domain}`;
}

module.exports = {
  generateNumericCode,
  hashResetCode,
  buildPasswordResetSmsBody,
  maskEmail,
};

