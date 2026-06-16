const { getClientIp } = require('../utils/clientIp');

function isTurnstileConfigured() {
  return !!process.env.TURNSTILE_SECRET_KEY;
}

async function verifyTurnstileToken(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { success: true, skipped: true };

  if (!token || typeof token !== 'string') {
    return { success: false, error: 'missing_token' };
  }

  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp && remoteIp !== 'unknown') {
    body.append('remoteip', remoteIp);
  }

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    return { success: false, error: 'verify_http_error' };
  }

  const data = await res.json();
  return data;
}

function requireTurnstile(req, res, next) {
  if (!isTurnstileConfigured()) return next();

  const token = req.body?.turnstileToken || req.body?.captchaToken;
  if (!token) {
    return res.status(400).json({
      message: 'Security verification required. Please complete the check and try again.',
      code: 'TURNSTILE_REQUIRED',
    });
  }

  verifyTurnstileToken(token, getClientIp(req))
    .then((result) => {
      if (result.success) return next();
      return res.status(403).json({
        message: 'Security verification failed. Please refresh and try again.',
        code: 'TURNSTILE_FAILED',
      });
    })
    .catch(() =>
      res.status(503).json({
        message: 'Security verification is temporarily unavailable. Please try again.',
        code: 'TURNSTILE_UNAVAILABLE',
      })
    );
}

module.exports = {
  isTurnstileConfigured,
  verifyTurnstileToken,
  requireTurnstile,
};
