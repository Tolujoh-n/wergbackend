const User = require('../models/User');
const {
  generateNumericCode,
  hashPhoneCode,
  toE164,
  maskPhone,
  buildVerificationSmsBody,
} = require('../utils/phoneVerification');
const { sendSms } = require('../utils/twilioSms');

const RESEND_SECONDS = () =>
  Math.max(30, parseInt(process.env.PHONE_VERIFY_RESEND_SECONDS || '60', 10));
const TTL_MINUTES = () => parseInt(process.env.PHONE_VERIFY_CODE_TTL_MINUTES || '10', 10);
const MAX_ATTEMPTS = () => parseInt(process.env.PHONE_VERIFY_MAX_ATTEMPTS || '5', 10);

function assertPhoneVerified(user) {
  if (!user?.phoneVerified || !user?.phone) {
    const err = new Error('Phone verification required before free predictions');
    err.statusCode = 403;
    err.code = 'PHONE_NOT_VERIFIED';
    throw err;
  }
}

async function sendVerificationCode(userId, countryDialCode, nationalNumber) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const e164 = toE164(countryDialCode, nationalNumber);

  const taken = await User.findOne({
    phone: e164,
    phoneVerified: true,
    _id: { $ne: user._id },
  }).lean();
  if (taken) {
    const err = new Error('This phone number is already linked to another account');
    err.statusCode = 409;
    throw err;
  }

  const pv = user.phoneVerification || {};
  if (pv.sentAt) {
    const elapsed = Date.now() - new Date(pv.sentAt).getTime();
    if (elapsed < RESEND_SECONDS() * 1000) {
      const waitSec = Math.ceil((RESEND_SECONDS() * 1000 - elapsed) / 1000);
      const err = new Error(`Please wait ${waitSec} seconds before requesting a new code`);
      err.statusCode = 429;
      err.retryAfterSeconds = waitSec;
      throw err;
    }
  }

  const code = generateNumericCode();
  const minutesValid = TTL_MINUTES();
  const appName = process.env.APP_NAME || 'WeRgame';
  const smsBody = buildVerificationSmsBody({ appName, code, minutesValid });

  await sendSms(e164, smsBody);

  user.phone = e164;
  user.phoneVerified = false;
  user.phoneVerification = {
    codeHash: hashPhoneCode(code),
    expiresAt: new Date(Date.now() + minutesValid * 60 * 1000),
    sentAt: new Date(),
    attempts: 0,
  };
  await user.save();

  return {
    phone: e164,
    phoneMasked: maskPhone(e164),
    expiresInMinutes: minutesValid,
    resendAfterSeconds: RESEND_SECONDS(),
  };
}

async function verifyPhoneCode(userId, codeRaw) {
  const code = String(codeRaw || '').trim().replace(/\D/g, '');
  if (code.length !== 6) {
    const err = new Error('Enter the 6-digit verification code');
    err.statusCode = 400;
    throw err;
  }

  const user = await User.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const pv = user.phoneVerification || {};
  if (!pv.codeHash || !pv.expiresAt) {
    const err = new Error('Request a verification code first');
    err.statusCode = 400;
    throw err;
  }

  if (pv.expiresAt.getTime() < Date.now()) {
    const err = new Error('Verification code expired. Request a new code.');
    err.statusCode = 400;
    throw err;
  }

  if ((pv.attempts || 0) >= MAX_ATTEMPTS()) {
    const err = new Error('Too many attempts. Request a new code.');
    err.statusCode = 400;
    throw err;
  }

  const ok = pv.codeHash === hashPhoneCode(code);
  if (!ok) {
    user.phoneVerification.attempts = (pv.attempts || 0) + 1;
    await user.save();
    const err = new Error('Incorrect verification code');
    err.statusCode = 400;
    throw err;
  }

  const e164 = user.phone;
  const taken = await User.findOne({
    phone: e164,
    phoneVerified: true,
    _id: { $ne: user._id },
  }).lean();
  if (taken) {
    const err = new Error('This phone number is already linked to another account');
    err.statusCode = 409;
    throw err;
  }

  user.phoneVerified = true;
  user.phoneVerification = {
    codeHash: null,
    expiresAt: null,
    sentAt: null,
    attempts: 0,
  };
  await user.save();

  return {
    phoneVerified: true,
    phone: e164,
    phoneMasked: maskPhone(e164),
  };
}

function phoneStatusForUser(user) {
  return {
    phoneVerified: !!user?.phoneVerified,
    phone: user?.phoneVerified ? user.phone : null,
    phoneMasked: user?.phoneVerified ? maskPhone(user.phone) : null,
    hasPendingVerification: !!(
      user?.phone &&
      !user?.phoneVerified &&
      user?.phoneVerification?.codeHash
    ),
  };
}

module.exports = {
  assertPhoneVerified,
  sendVerificationCode,
  verifyPhoneCode,
  phoneStatusForUser,
  maskPhone,
};
