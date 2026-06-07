function getTwilioCredentials() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  return { accountSid, authToken };
}

function getVerifyServiceSid() {
  return process.env.TWILIO_VERIFY_SERVICE_SID || '';
}

function isTwilioVerifyEmailConfigured() {
  const { accountSid, authToken } = getTwilioCredentials();
  return !!(accountSid && authToken && getVerifyServiceSid());
}

function getVerifyClient() {
  const { accountSid, authToken } = getTwilioCredentials();
  if (!accountSid || !authToken) {
    const err = new Error(
      'Twilio is not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server.'
    );
    err.statusCode = 503;
    throw err;
  }
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  return twilio(accountSid, authToken);
}

/**
 * Send a one-time code to the user's email via Twilio Verify (email channel).
 * Twilio delivers the email; use checkEmailVerificationCode to validate the code.
 */
async function sendEmailVerificationCode(email) {
  const serviceSid = getVerifyServiceSid();
  if (!serviceSid) {
    const err = new Error(
      'Email verification is not configured. Set TWILIO_VERIFY_SERVICE_SID (Twilio Console → Verify → Services, enable Email).'
    );
    err.statusCode = 503;
    throw err;
  }

  const to = String(email || '').trim().toLowerCase();
  if (!to || !to.includes('@')) {
    const err = new Error('Invalid email address');
    err.statusCode = 400;
    throw err;
  }

  const client = getVerifyClient();
  const verification = await client.verify.v2.services(serviceSid).verifications.create({
    to,
    channel: 'email',
  });

  return { sid: verification.sid, status: verification.status };
}

/**
 * @returns {boolean} true when Twilio approves the code
 */
async function checkEmailVerificationCode(email, code) {
  const serviceSid = getVerifyServiceSid();
  if (!serviceSid) {
    const err = new Error('Email verification is not configured');
    err.statusCode = 503;
    throw err;
  }

  const to = String(email || '').trim().toLowerCase();
  const rawCode = String(code || '').trim().replace(/\D/g, '');
  if (!to || rawCode.length < 4) return false;

  try {
    const client = getVerifyClient();
    const check = await client.verify.v2.services(serviceSid).verificationChecks.create({
      to,
      code: rawCode,
    });
    return check.status === 'approved';
  } catch (e) {
    // Invalid / expired OTP
    if (e.code === 60200 || e.code === 60202 || e.status === 404) {
      return false;
    }
    throw e;
  }
}

module.exports = {
  isTwilioVerifyEmailConfigured,
  sendEmailVerificationCode,
  checkEmailVerificationCode,
};
