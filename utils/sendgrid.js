const sgMail = require('@sendgrid/mail');

function envValue(key) {
  const raw = process.env[key];
  if (raw == null || raw === '') return '';
  return String(raw).trim().replace(/^["']|["']$/g, '');
}

function isDevEmailOtpLogEnabled() {
  return (
    envValue('EMAIL_VERIFY_DEV_LOG') === 'true' || envValue('PASSWORD_RESET_DEV_LOG') === 'true'
  );
}

function isSendgridConfigured() {
  return !!(envValue('SENDGRID_API_KEY') && envValue('SENDGRID_FROM_EMAIL'));
}

/** Use SendGrid whenever API key + from address are set. */
function shouldSendViaSendgrid() {
  return isSendgridConfigured();
}

/** Console OTP only when SendGrid is missing and dev logging is on. */
function shouldLogDevOtpToConsole() {
  return !isSendgridConfigured() && isDevEmailOtpLogEnabled();
}

function logDevEmailOtp(label, email, code, minutesValid = 10) {
  const line = '='.repeat(52);
  console.log(`\n${line}`);
  console.log(`[${label}] DEV — OTP (SendGrid not configured)`);
  console.log(`  Email:   ${email}`);
  console.log(`  Code:    ${code}`);
  console.log(`  Expires: ${minutesValid} minute(s)`);
  console.log(`${line}\n`);
}

function getSendgridConfigured() {
  const apiKey = envValue('SENDGRID_API_KEY');
  if (!apiKey) {
    throw new Error('SENDGRID_API_KEY is not set');
  }
  sgMail.setApiKey(apiKey);
  return sgMail;
}

function parseFromAddress() {
  const email = envValue('SENDGRID_FROM_EMAIL');
  if (!email) {
    throw new Error('SENDGRID_FROM_EMAIL is not set');
  }
  if (email.includes('<') && email.includes('>')) {
    return email;
  }
  const name = envValue('SENDGRID_FROM_NAME') || envValue('APP_NAME') || 'WeRgame';
  return { email, name };
}

function formatSendgridError(err) {
  const errors = err?.response?.body?.errors;
  if (Array.isArray(errors) && errors.length) {
    return errors.map((e) => e.message).filter(Boolean).join('; ');
  }
  return err?.message || 'SendGrid request failed';
}

async function deliverSendgridMessage(msg) {
  const sg = getSendgridConfigured();
  try {
    const [response] = await sg.send(msg);
    const statusCode = response?.statusCode || 202;
    if (statusCode >= 400) {
      const err = new Error(`SendGrid rejected the email (HTTP ${statusCode})`);
      err.statusCode = 502;
      throw err;
    }
    return { statusCode, messageId: response?.headers?.['x-message-id'] || null };
  } catch (err) {
    const detail = formatSendgridError(err);
    const wrapped = new Error(
      detail.includes('SendGrid') ? detail : `Failed to send email via SendGrid: ${detail}`
    );
    wrapped.statusCode = 502;
    wrapped.cause = err;
    throw wrapped;
  }
}

function buildOtpEmailHtml({ product, title, subtitle, code, minutes, footerNote }) {
  const digits = String(code).split('');
  const digitCells = digits
    .map(
      (d) =>
        `<td style="width:44px;height:52px;text-align:center;font-size:26px;font-weight:700;color:#0f172a;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-family:ui-monospace,Menlo,Consolas,monospace;">${d}</td>`
    )
    .join('<td style="width:8px;"></td>');

  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.08);">
        <tr><td style="background:linear-gradient(135deg,#1d4ed8 0%,#2563eb 55%,#3b82f6 100%);padding:28px 32px;">
          <div style="font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.85);">${product}</div>
          <div style="margin-top:8px;font-size:24px;font-weight:700;color:#ffffff;line-height:1.3;">${title}</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#334155;">${subtitle}</p>
          <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto 20px;"><tr>${digitCells}</tr></table>
          <p style="margin:0 0 8px;font-size:14px;color:#64748b;text-align:center;">Expires in <strong style="color:#0f172a;">${minutes} minutes</strong></p>
          <div style="margin-top:24px;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
            <p style="margin:0;font-size:13px;line-height:1.5;color:#64748b;">Never share this code with anyone. ${product} staff will never ask for it.</p>
          </div>
        </td></tr>
        <tr><td style="padding:0 32px 28px;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;text-align:center;">${footerNote}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

/**
 * Send a 6-digit password reset code to the user's email.
 */
async function sendPasswordResetEmail({ to, code, minutesValid, appName }) {
  const from = parseFromAddress();
  const product = appName || envValue('APP_NAME') || 'WeRgame';
  const minutes = minutesValid || 10;

  const delivery = await deliverSendgridMessage({
    to,
    from,
    subject: `${product} — Password reset code`,
    text: `${product}: Your password reset code is ${code}. It expires in ${minutes} minutes. Do not share this code. If you did not request a password reset, ignore this email.`,
    html: buildOtpEmailHtml({
      product,
      title: 'Reset your password',
      subtitle: 'Use this one-time code to reset your password.',
      code,
      minutes,
      footerNote: 'If you did not request a password reset, you can safely ignore this email.',
    }),
  });

  console.log('[sendgrid] password reset OTP accepted for', to, 'status', delivery.statusCode);
  return delivery;
}

/**
 * Send a 6-digit free-play verification code to the user's email.
 */
async function sendFreePlayVerificationEmail({ to, code, minutesValid, appName, username, isReverify }) {
  const from = parseFromAddress();
  const product = appName || envValue('APP_NAME') || 'WeRgame';
  const minutes = minutesValid || 10;
  const greeting = username ? `Hi ${username},` : 'Hi there,';
  const validDays = parseInt(envValue('EMAIL_VERIFY_VALID_DAYS') || '30', 10);

  const subject = isReverify
    ? `${product} — Re-verify your email for free predictions`
    : `${product} — Verify your email to play free predictions`;

  const title = isReverify ? 'Re-verify your email' : 'Verify your email';
  const subtitle = isReverify
    ? `${greeting}<br><br>Your free-play email verification has expired. Enter this code to continue placing <strong>free predictions</strong> for the next ${validDays} days.`
    : `${greeting}<br><br>Enter this code on ${product} to unlock <strong>free predictions</strong> for ${validDays} days.`;

  const delivery = await deliverSendgridMessage({
    to,
    from,
    subject,
    text: `${product}: ${greeting} Your verification code is ${code}. It expires in ${minutes} minutes.`,
    html: buildOtpEmailHtml({
      product,
      title,
      subtitle,
      code,
      minutes,
      footerNote: 'If you did not request this code, you can safely ignore this email.',
    }),
  });

  console.log('[sendgrid] free-play OTP accepted for', to, 'status', delivery.statusCode);
  return delivery;
}

module.exports = {
  envValue,
  isSendgridConfigured,
  isDevEmailOtpLogEnabled,
  shouldSendViaSendgrid,
  shouldLogDevOtpToConsole,
  logDevEmailOtp,
  getSendgridConfigured,
  parseFromAddress,
  formatSendgridError,
  deliverSendgridMessage,
  sendPasswordResetEmail,
  sendFreePlayVerificationEmail,
  buildOtpEmailHtml,
};
