/**
 * Shared OTP delivery result helpers for email verification + password reset.
 */
const {
  shouldSendViaSendgrid,
  shouldLogDevOtpToConsole,
  logDevEmailOtp,
  isSendgridConfigured,
  isDevEmailOtpLogEnabled,
} = require('../utils/sendgrid');

function assertOtpDeliveryConfigured() {
  if (isSendgridConfigured()) return;
  if (isDevEmailOtpLogEnabled()) return;
  const err = new Error(
    'Email delivery is not configured. Set SENDGRID_API_KEY and SENDGRID_FROM_EMAIL, or enable EMAIL_VERIFY_DEV_LOG=true for local console codes.'
  );
  err.statusCode = 503;
  throw err;
}

async function deliverOtpCode({ label, email, code, minutesValid, sendEmail }) {
  if (shouldSendViaSendgrid()) {
    await sendEmail();
    return {
      sent: true,
      channel: 'email',
      dev: false,
    };
  }

  if (shouldLogDevOtpToConsole()) {
    logDevEmailOtp(label, email, code, minutesValid);
    return {
      sent: true,
      channel: 'console',
      dev: true,
    };
  }

  const err = new Error('Email delivery is not configured on the server.');
  err.statusCode = 503;
  throw err;
}

function buildOtpSentMessage({ channel, emailMasked }) {
  if (channel === 'email') {
    return `Verification code sent to ${emailMasked}. Check your inbox and spam folder.`;
  }
  if (channel === 'console') {
    return 'Verification code logged on the server console (dev mode). Check your backend terminal.';
  }
  return 'Verification code could not be sent.';
}

function buildPasswordResetSentMessage({ channel, emailMasked }) {
  if (channel === 'email') {
    return `Password reset code sent to ${emailMasked}. Check your inbox and spam folder.`;
  }
  if (channel === 'console') {
    return 'Password reset code logged on the server console (dev mode). Check your backend terminal.';
  }
  return 'Password reset code could not be sent.';
}

module.exports = {
  assertOtpDeliveryConfigured,
  deliverOtpCode,
  buildOtpSentMessage,
  buildPasswordResetSentMessage,
};
