const crypto = require('crypto');

const CODE_LENGTH = 6;

function generateNumericCode() {
  const min = 10 ** (CODE_LENGTH - 1);
  const max = 10 ** CODE_LENGTH - 1;
  return String(crypto.randomInt(min, max + 1));
}

function getPhoneVerifySecret() {
  return process.env.PHONE_VERIFY_SECRET || process.env.JWT_SECRET || 'your-secret-key';
}

function hashPhoneCode(code) {
  const secret = getPhoneVerifySecret();
  return crypto.createHash('sha256').update(`phone-verify:${code}:${secret}`).digest('hex');
}

/**
 * Build E.164 from dial code (e.g. "1", "234") and national digits.
 */
function toE164(countryDialCode, nationalNumber) {
  const dial = String(countryDialCode || '').replace(/\D/g, '');
  let national = String(nationalNumber || '').replace(/\D/g, '');
  if (!dial || dial.length < 1 || dial.length > 4) {
    const err = new Error('Invalid country code');
    err.statusCode = 400;
    throw err;
  }
  if (national.startsWith('0')) national = national.slice(1);
  if (national.length < 4 || national.length > 14) {
    const err = new Error('Invalid phone number');
    err.statusCode = 400;
    throw err;
  }
  const e164 = `+${dial}${national}`;
  if (!/^\+\d{8,15}$/.test(e164)) {
    const err = new Error('Invalid phone number format');
    err.statusCode = 400;
    throw err;
  }
  return e164;
}

function maskPhone(e164) {
  const s = String(e164 || '');
  if (s.length < 8) return '••••';
  return `${s.slice(0, 3)} ••• ••${s.slice(-2)}`;
}

function buildVerificationSmsBody({ appName, code, minutesValid }) {
  const product = appName || 'WeRgame';
  const validity = minutesValid || 10;
  return `${product}: Your verification code is ${code}. It expires in ${validity} minutes. Do not share this code.`;
}

module.exports = {
  generateNumericCode,
  hashPhoneCode,
  toE164,
  maskPhone,
  buildVerificationSmsBody,
  CODE_LENGTH,
};
