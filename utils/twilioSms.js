function isTwilioConfigured() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  return !!(sid && token && (from || messagingServiceSid));
}

function isDevLogMode() {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.PHONE_VERIFY_DEV_LOG === 'true';
}

function twilioErrorMessage(err) {
  const code = err?.code;
  const msg = err?.message || 'Twilio SMS failed';
  if (code === 21408 || code === 21614) {
    return 'SMS to this country is not enabled on Twilio. Enable Nigeria under Geo Permissions in Twilio Console.';
  }
  if (code === 21612 || code === 21211) {
    return 'This phone number cannot receive SMS from our provider. Check the number or try another.';
  }
  if (code === 21610) {
    return 'This number is blocked from receiving messages.';
  }
  if (code === 30044 || code === 21608) {
    return 'Twilio trial accounts can only SMS verified numbers. Upgrade the account or verify this number in Twilio.';
  }
  if (code === 20003 || code === 20403) {
    return 'Twilio authentication failed. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server.';
  }
  if (code === 21606) {
    return 'The Twilio sender number is not SMS-capable. Check TWILIO_PHONE_NUMBER or use a Messaging Service.';
  }
  return msg;
}

/**
 * Send SMS via Twilio. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and
 * TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID.
 */
async function sendSms(toE164, body) {
  if (!isTwilioConfigured()) {
    if (isDevLogMode()) {
      console.log('[twilioSms] DEV — would send to', toE164, ':', body);
      return { sid: 'dev', dev: true, status: 'dev' };
    }
    const err = new Error(
      'SMS is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER on the server.'
    );
    err.statusCode = 503;
    throw err;
  }

  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  const payload = {
    to: toE164,
    body: String(body).slice(0, 1600),
  };

  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    payload.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  } else {
    payload.from = process.env.TWILIO_PHONE_NUMBER;
  }

  try {
    const msg = await client.messages.create(payload);
    console.log('[twilioSms] queued', {
      sid: msg.sid,
      to: toE164,
      status: msg.status,
      bodyPreview: String(payload.body).slice(0, 80),
      from: msg.from || process.env.TWILIO_MESSAGING_SERVICE_SID || 'messaging-service',
    });
    return { sid: msg.sid, status: msg.status };
  } catch (err) {
    console.error('[twilioSms] send failed', {
      to: toE164,
      code: err?.code,
      status: err?.status,
      message: err?.message,
    });
    const wrapped = new Error(twilioErrorMessage(err));
    wrapped.statusCode = err?.status === 400 ? 400 : 502;
    wrapped.twilioCode = err?.code;
    throw wrapped;
  }
}

module.exports = { sendSms, isTwilioConfigured, isDevLogMode };
