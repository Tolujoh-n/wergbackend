const {
  generateNumericCode,
  hashResetCode,
  maskEmail,
} = require('../utils/passwordReset');
const { shouldSendViaSendgrid, isDevEmailOtpLogEnabled, logDevEmailOtp, sendPasswordResetEmail } = require('../utils/sendgrid');

const TTL_MINUTES = () => parseInt(process.env.PASSWORD_RESET_CODE_TTL_MINUTES || '10', 10);
const RESEND_SECONDS = () =>
  Math.max(
    30,
    parseInt(
      process.env.PASSWORD_RESET_RESEND_SECONDS ||
        process.env.EMAIL_VERIFY_RESEND_SECONDS ||
        '60',
      10
    )
  );

function isDevPasswordReset() {
  return isDevEmailOtpLogEnabled();
}

function assertCanSendPasswordResetEmail() {
  if (shouldSendViaSendgrid()) return;
  if (isDevPasswordReset()) return;
  const err = new Error(
    'Password reset email is not configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL on the server. For local dev, set PASSWORD_RESET_DEV_LOG=true.'
  );
  err.statusCode = 503;
  throw err;
}

function enforceResendCooldown(user) {
  const pr = user.passwordReset || {};
  if (!pr.sentAt) return;
  const elapsed = Date.now() - new Date(pr.sentAt).getTime();
  if (elapsed < RESEND_SECONDS() * 1000) {
    const waitSec = Math.ceil((RESEND_SECONDS() * 1000 - elapsed) / 1000);
    const err = new Error(`Please wait ${waitSec} seconds before requesting a new code`);
    err.statusCode = 429;
    err.retryAfterSeconds = waitSec;
    throw err;
  }
}

function clearPasswordReset(user) {
  user.passwordReset = {
    provider: null,
    codeHash: null,
    verifiedAt: null,
    expiresAt: null,
    sentAt: null,
    attempts: 0,
  };
}

/**
 * Email password reset for accounts that signed up with email + password.
 * Sends a 6-digit code via SendGrid.
 */
async function sendPasswordResetCode(user) {
  if (!user?.email || !user?.password) {
    return { sent: false };
  }

  assertCanSendPasswordResetEmail();
  enforceResendCooldown(user);

  const email = String(user.email).trim().toLowerCase();
  const minutesValid = TTL_MINUTES();
  const sentAt = new Date();
  const code = generateNumericCode();

  user.passwordReset = {
    provider: shouldSendViaSendgrid() ? 'sendgrid' : 'local',
    codeHash: hashResetCode(code),
    verifiedAt: null,
    expiresAt: new Date(Date.now() + minutesValid * 60 * 1000),
    sentAt,
    attempts: 0,
  };
  await user.save();

  try {
    if (shouldSendViaSendgrid()) {
      await sendPasswordResetEmail({
        to: email,
        code,
        minutesValid,
        appName: process.env.APP_NAME,
      });
    } else {
      logDevEmailOtp('passwordReset', email, code, minutesValid);
    }
  } catch (e) {
    clearPasswordReset(user);
    await user.save();
    const err = new Error('Unable to send reset email. Please try again later.');
    err.statusCode = 502;
    throw err;
  }

  return {
    sent: true,
    emailMasked: maskEmail(email),
    expiresInMinutes: minutesValid,
    resendAfterSeconds: RESEND_SECONDS(),
    dev: isDevPasswordReset() || !shouldSendViaSendgrid(),
  };
}

function normalizeResetCode(codeRaw) {
  return String(codeRaw || '').trim().replace(/\D/g, '');
}

async function verifyPasswordResetCode(user, codeRaw) {
  const code = normalizeResetCode(codeRaw);
  if (code.length !== 6) {
    return false;
  }
  if (!user?.email) {
    return false;
  }

  const pr = user.passwordReset || {};
  const maxAttempts = parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS || '5', 10);
  if ((pr.attempts || 0) >= maxAttempts) {
    const err = new Error('Invalid or expired code');
    err.statusCode = 400;
    throw err;
  }

  if (!pr.codeHash || !pr.expiresAt) {
    return false;
  }

  if (pr.expiresAt.getTime() < Date.now()) {
    const err = new Error('Invalid or expired code');
    err.statusCode = 400;
    throw err;
  }

  const ok = pr.codeHash === hashResetCode(code);

  if (!ok) {
    user.passwordReset.attempts = (pr.attempts || 0) + 1;
    await user.save();
    return false;
  }

  const minutesValid = TTL_MINUTES();
  user.passwordReset = {
    ...pr,
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + minutesValid * 60 * 1000),
    attempts: 0,
  };
  await user.save();
  return true;
}

function isPasswordResetVerified(user) {
  const pr = user?.passwordReset || {};
  if (!pr.verifiedAt || !pr.expiresAt || !pr.codeHash) return false;
  return pr.expiresAt.getTime() >= Date.now();
}

/**
 * Final step: re-check code + verified window, then set new password.
 */
async function confirmPasswordReset(user, codeRaw, newPassword) {
  if (!user?.email) {
    const err = new Error('Invalid or expired code. Verify your code again.');
    err.statusCode = 400;
    throw err;
  }

  const code = normalizeResetCode(codeRaw);
  if (code.length !== 6) {
    const err = new Error('Enter the 6-digit verification code');
    err.statusCode = 400;
    throw err;
  }

  if (!isPasswordResetVerified(user)) {
    const err = new Error('Invalid or expired code. Verify your code again.');
    err.statusCode = 400;
    throw err;
  }

  const pr = user.passwordReset || {};
  if (pr.codeHash !== hashResetCode(code)) {
    const err = new Error('Invalid or expired code');
    err.statusCode = 400;
    throw err;
  }

  if (String(newPassword).length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.statusCode = 400;
    throw err;
  }

  user.password = newPassword;
  user.passwordReset = {
    provider: null,
    codeHash: null,
    verifiedAt: null,
    expiresAt: null,
    sentAt: null,
    attempts: 0,
  };
  await user.save();
  return { ok: true };
}

module.exports = {
  sendPasswordResetCode,
  verifyPasswordResetCode,
  isPasswordResetVerified,
  confirmPasswordReset,
};
