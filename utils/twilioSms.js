function isTwilioConfigured() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  return !!(sid && token && (from || messagingServiceSid));
}

/**
 * Send SMS via Twilio. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and
 * TWILIO_PHONE_NUMBER or TWILIO_MESSAGING_SERVICE_SID.
 */
async function sendSms(toE164, body) {
  if (!isTwilioConfigured()) {
    if (process.env.PHONE_VERIFY_DEV_LOG === 'true') {
      console.log('[twilioSms] DEV — would send to', toE164, ':', body);
      return { sid: 'dev', dev: true };
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

  const msg = await client.messages.create(payload);
  return { sid: msg.sid };
}

module.exports = { sendSms, isTwilioConfigured };
