const { getClientIp } = require('../utils/clientIp');
const { consumeRateLimit } = require('../services/ipRateLimitService');

function createIpRateLimiter({ action, limit, windowMs, message }) {
  return async (req, res, next) => {
    try {
      const ip = getClientIp(req);
      await consumeRateLimit({ key: `${action}:${ip}`, limit, windowMs });
      return next();
    } catch (e) {
      if (e.message === 'RATE_LIMIT_EXCEEDED') {
        return res.status(429).json({
          message: message || 'Too many requests. Please try again later.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: e.retryAfterSeconds,
        });
      }
      return next(e);
    }
  };
}

const loginRateLimit = createIpRateLimiter({
  action: 'auth:login',
  limit: 5,
  windowMs: 60 * 1000,
  message: 'Too many login attempts. Please try again in a minute.',
});

const signupRateLimit = createIpRateLimiter({
  action: 'auth:signup',
  limit: 3,
  windowMs: 60 * 60 * 1000,
  message:
    "You've reached the registration limit for this device/network. Please try again in 1 hour.",
});

module.exports = {
  loginRateLimit,
  signupRateLimit,
  createIpRateLimiter,
};
