const User = require('../models/User');
const {
  generateNumericCode,
  hashEmailVerifyCode,
  maskEmail,
} = require('../utils/emailVerification');
const { assertAllowedEmail, normalizeEmail } = require('../utils/disposableEmail');
const { isSendgridConfigured, sendFreePlayVerificationEmail } = require('../utils/sendgrid');

const RESEND_SECONDS = () =>
  Math.max(30, parseInt(process.env.EMAIL_VERIFY_RESEND_SECONDS || '60', 10));
const TTL_MINUTES = () => parseInt(process.env.EMAIL_VERIFY_CODE_TTL_MINUTES || '10', 10);
const MAX_ATTEMPTS = () => parseInt(process.env.EMAIL_VERIFY_MAX_ATTEMPTS || '5', 10);
const VALID_DAYS = () => Math.max(1, parseInt(process.env.EMAIL_VERIFY_VALID_DAYS || '30', 10));
const VALID_MS = () => VALID_DAYS() * 24 * 60 * 60 * 1000;

function isDevEmailVerify() {
  return process.env.EMAIL_VERIFY_DEV_LOG === 'true' || process.env.PASSWORD_RESET_DEV_LOG === 'true';
}

function assertCanSendEmail() {
  if (isSendgridConfigured()) return;
  if (isDevEmailVerify()) return;
  const err = new Error(
    'Email verification is not configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL on the server.'
  );
  err.statusCode = 503;
  throw err;
}

function getEmailVerifiedAt(user) {
  if (!user?.emailVerifiedAt) return null;
  const d = new Date(user.emailVerifiedAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getEmailVerificationExpiresAt(user) {
  const at = getEmailVerifiedAt(user);
  if (!at) return null;
  return new Date(at.getTime() + VALID_MS());
}

/** True when user can place free predictions right now (within 30-day window). */
function isFreePlayEmailValid(user) {
  if (user?.phoneVerified && !user?.emailVerifiedAt) {
    // Legacy SMS users: treat as valid until they migrate to email re-verify flow
    return true;
  }
  if (!user?.emailVerified || !user?.emailVerifiedAt) return false;
  const at = getEmailVerifiedAt(user);
  if (!at) return false;
  return Date.now() - at.getTime() < VALID_MS();
}

function needsEmailReverification(user) {
  if (!user?.emailVerified || !user?.emailVerifiedAt) return false;
  return !isFreePlayEmailValid(user);
}

/** Backfill verifiedAt for users verified before this field existed. */
async function ensureLegacyEmailVerifiedAt(user) {
  if (!user) return user;
  if (user.emailVerifiedAt) return user;
  if (user.emailVerified || user.phoneVerified) {
    user.emailVerifiedAt = new Date();
    await user.save();
  }
  return user;
}

function assertEmailVerified(user) {
  if (isFreePlayEmailValid(user)) return;
  const err = new Error(
    needsEmailReverification(user)
      ? 'Email verification expired. Please verify your email again to use free predictions.'
      : 'Email verification required before free predictions'
  );
  err.statusCode = 403;
  err.code = needsEmailReverification(user) ? 'EMAIL_VERIFICATION_EXPIRED' : 'EMAIL_NOT_VERIFIED';
  throw err;
}

function emailStatusForUser(user) {
  const canPlayFree = isFreePlayEmailValid(user);
  const pendingEmail = user?.freePlayEmailVerification?.pendingEmail || null;
  const displayEmail = user?.email || pendingEmail || null;
  const expiresAt = getEmailVerificationExpiresAt(user);
  const reverify = needsEmailReverification(user);

  return {
    /** True only while the 30-day free-play window is active. */
    emailVerified: canPlayFree,
    email: user?.email || null,
    emailMasked: displayEmail ? maskEmail(displayEmail) : null,
    emailVerifiedAt: getEmailVerifiedAt(user),
    emailVerificationExpiresAt: expiresAt,
    emailVerificationValidDays: VALID_DAYS(),
    needsReverification: reverify,
    needsEmail: !user?.email && !canPlayFree && !reverify,
    hasPendingVerification: !!(
      !canPlayFree &&
      user?.freePlayEmailVerification?.codeHash &&
      (user?.email || pendingEmail)
    ),
    phoneVerified: canPlayFree,
    phoneMasked: null,
  };
}

async function sendVerificationCode(userId, requestedEmail = null) {
  const user = await User.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  await ensureLegacyEmailVerifiedAt(user);

  if (isFreePlayEmailValid(user)) {
    const err = new Error('Email is already verified for free predictions');
    err.statusCode = 400;
    throw err;
  }

  let targetEmail;
  if (requestedEmail) {
    targetEmail = assertAllowedEmail(requestedEmail);
  } else if (user.email) {
    targetEmail = assertAllowedEmail(user.email);
  } else {
    const err = new Error('Add your email address to receive a verification code');
    err.statusCode = 400;
    throw err;
  }

  const taken = await User.findOne({
    email: targetEmail,
    _id: { $ne: user._id },
  }).lean();
  if (taken) {
    const err = new Error('This email is already linked to another account');
    err.statusCode = 409;
    throw err;
  }

  const ev = user.freePlayEmailVerification || {};
  if (ev.sentAt) {
    const elapsed = Date.now() - new Date(ev.sentAt).getTime();
    if (elapsed < RESEND_SECONDS() * 1000) {
      const waitSec = Math.ceil((RESEND_SECONDS() * 1000 - elapsed) / 1000);
      const err = new Error(`Please wait ${waitSec} seconds before requesting a new code`);
      err.statusCode = 429;
      err.retryAfterSeconds = waitSec;
      throw err;
    }
  }

  assertCanSendEmail();

  const code = generateNumericCode();
  const minutesValid = TTL_MINUTES();
  const appName = process.env.APP_NAME || 'WeRgame';
  const isReverify = needsEmailReverification(user) || !!user.emailVerified;

  user.freePlayEmailVerification = {
    codeHash: hashEmailVerifyCode(code),
    expiresAt: new Date(Date.now() + minutesValid * 60 * 1000),
    sentAt: new Date(),
    attempts: 0,
    pendingEmail: targetEmail,
  };
  await user.save();

  try {
    if (isSendgridConfigured()) {
      await sendFreePlayVerificationEmail({
        to: targetEmail,
        code,
        minutesValid,
        appName,
        username: user.username,
        isReverify,
      });
    } else {
      console.log('[emailVerify] DEV — code for', targetEmail, ':', code);
    }
  } catch (e) {
    user.freePlayEmailVerification = {
      codeHash: null,
      expiresAt: null,
      sentAt: null,
      attempts: 0,
      pendingEmail: null,
    };
    await user.save();
    const err = new Error('Unable to send verification email. Please try again later.');
    err.statusCode = 502;
    throw err;
  }

  return {
    email: targetEmail,
    emailMasked: maskEmail(targetEmail),
    expiresInMinutes: minutesValid,
    resendAfterSeconds: RESEND_SECONDS(),
    isReverify,
    dev: !isSendgridConfigured(),
  };
}

async function verifyEmailCode(userId, codeRaw) {
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

  const ev = user.freePlayEmailVerification || {};
  if (!ev.codeHash || !ev.expiresAt) {
    const err = new Error('Request a verification code first');
    err.statusCode = 400;
    throw err;
  }

  if (ev.expiresAt.getTime() < Date.now()) {
    const err = new Error('Verification code expired. Request a new code.');
    err.statusCode = 400;
    throw err;
  }

  if ((ev.attempts || 0) >= MAX_ATTEMPTS()) {
    const err = new Error('Too many attempts. Request a new code.');
    err.statusCode = 400;
    throw err;
  }

  const ok = ev.codeHash === hashEmailVerifyCode(code);
  if (!ok) {
    user.freePlayEmailVerification.attempts = (ev.attempts || 0) + 1;
    await user.save();
    const err = new Error('Incorrect verification code');
    err.statusCode = 400;
    throw err;
  }

  const targetEmail = ev.pendingEmail || user.email;
  if (!targetEmail) {
    const err = new Error('No email on file. Request a new code.');
    err.statusCode = 400;
    throw err;
  }

  const normalized = assertAllowedEmail(targetEmail);
  const taken = await User.findOne({
    email: normalized,
    _id: { $ne: user._id },
  }).lean();
  if (taken) {
    const err = new Error('This email is already linked to another account');
    err.statusCode = 409;
    throw err;
  }

  const now = new Date();
  user.email = normalized;
  user.emailVerified = true;
  user.emailVerifiedAt = now;
  user.freePlayEmailVerification = {
    codeHash: null,
    expiresAt: null,
    sentAt: null,
    attempts: 0,
    pendingEmail: null,
  };
  await user.save();

  const expiresAt = new Date(now.getTime() + VALID_MS());

  return {
    emailVerified: true,
    email: normalized,
    emailMasked: maskEmail(normalized),
    emailVerifiedAt: now,
    emailVerificationExpiresAt: expiresAt,
    emailVerificationValidDays: VALID_DAYS(),
  };
}

module.exports = {
  assertEmailVerified,
  sendVerificationCode,
  verifyEmailCode,
  emailStatusForUser,
  isFreePlayEmailValid,
  ensureLegacyEmailVerifiedAt,
  VALID_DAYS,
};
