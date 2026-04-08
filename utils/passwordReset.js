const crypto = require('crypto');

const CODE_LENGTH = 6;

function generateNumericCode() {
  const min = 10 ** (CODE_LENGTH - 1);
  const max = 10 ** CODE_LENGTH - 1;
  return String(crypto.randomInt(min, max + 1));
}

function getResetSecret() {
  return process.env.PASSWORD_RESET_SECRET || process.env.JWT_SECRET || 'your-secret-key';
}

function hashResetCode(code) {
  const secret = getResetSecret();
  return crypto.createHash('sha256').update(`${code}:${secret}`).digest('hex');
}

function buildPasswordResetEmail({ appName, code, minutesValid }) {
  const product = appName || 'WeRgame';
  const validity = minutesValid || 10;
  return {
    subject: `${product} password reset code`,
    text: [
      `Your ${product} password reset code is: ${code}`,
      '',
      `This code expires in ${validity} minutes.`,
      'If you did not request a password reset, you can ignore this email.',
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.5; color: #111827;">
        <h2 style="margin: 0 0 12px;">Reset your password</h2>
        <p style="margin: 0 0 12px;">Use the verification code below to reset your password for <strong>${product}</strong>:</p>
        <div style="display: inline-block; padding: 12px 16px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; margin: 8px 0 16px;">
          <div style="font-size: 22px; letter-spacing: 4px; font-weight: 700; color: #1d4ed8;">${code}</div>
        </div>
        <p style="margin: 0 0 12px;">This code expires in <strong>${validity} minutes</strong>.</p>
        <p style="margin: 0; color: #6b7280;">If you didn’t request this, you can safely ignore this email.</p>
      </div>
    `,
  };
}

module.exports = {
  generateNumericCode,
  hashResetCode,
  buildPasswordResetEmail,
};

