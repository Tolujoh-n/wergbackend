const sgMail = require('@sendgrid/mail');

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

module.exports = {
  getSendgridConfigured,
  getSendgridFromEmail,
};

