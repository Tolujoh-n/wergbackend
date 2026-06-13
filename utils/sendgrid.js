const sgMail = require('@sendgrid/mail');

function isSendgridConfigured() {
  return !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);
}

function getSendgridConfigured() {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error('SENDGRID_API_KEY is not set');
  }
  sgMail.setApiKey(apiKey);
  return sgMail;
}

function getSendgridFromEmail() {
  const from = process.env.SENDGRID_FROM_EMAIL;
  if (!from) {
    throw new Error('SENDGRID_FROM_EMAIL is not set');
  }
  return from;
}

/**
 * Send a 6-digit password reset code to the user's email.
 */
async function sendPasswordResetEmail({ to, code, minutesValid, appName }) {
  const sg = getSendgridConfigured();
  const from = getSendgridFromEmail();
  const product = appName || process.env.APP_NAME || 'WeRgame';
  const minutes = minutesValid || 10;

  await sg.send({
    to,
    from,
    subject: `${product} — Password reset code`,
    text: `${product}: Your password reset code is ${code}. It expires in ${minutes} minutes. Do not share this code. If you did not request a password reset, ignore this email.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;line-height:1.5;color:#111">
        <p>Use this code to reset your ${product} password:</p>
        <p style="font-size:28px;font-weight:bold;letter-spacing:4px;margin:16px 0">${code}</p>
        <p style="color:#555">This code expires in ${minutes} minutes.</p>
        <p style="color:#888;font-size:13px">If you did not request a password reset, you can ignore this email.</p>
      </div>
    `.trim(),
  });
}

module.exports = {
  isSendgridConfigured,
  getSendgridConfigured,
  getSendgridFromEmail,
  sendPasswordResetEmail,
};
