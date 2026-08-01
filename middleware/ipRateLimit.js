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

const walletSignupRateLimit = createIpRateLimiter({
  action: 'auth:wallet-signup',
  limit: 5,
  windowMs: 60 * 60 * 1000,
  message:
    "You've reached the wallet registration limit for this device/network. Please try again later.",
});

const walletLoginRateLimit = createIpRateLimiter({
  action: 'auth:wallet-login',
  limit: 30,
  windowMs: 60 * 1000,
  message: 'Too many wallet login attempts. Please try again in a minute.',
});

const walletChallengeRateLimit = createIpRateLimiter({
  action: 'auth:wallet-challenge',
  limit: 30,
  windowMs: 60 * 1000,
  message: 'Too many wallet challenge requests. Please wait a minute.',
});

const passwordResetRateLimit = createIpRateLimiter({
  action: 'auth:password-reset',
  limit: 10,
  windowMs: 60 * 60 * 1000,
  message: 'Too many password reset requests. Please try again later.',
});

const googleAuthRateLimit = createIpRateLimiter({
  action: 'auth:google',
  limit: 20,
  windowMs: 60 * 1000,
  message: 'Too many Google sign-in attempts. Please wait a minute.',
});

const vaultWithdrawAuthRateLimit = createIpRateLimiter({
  action: 'orderbook:vault-withdraw-auth',
  limit: 20,
  windowMs: 60 * 1000,
  message: 'Too many vault withdraw requests. Please wait a minute.',
});

module.exports = {
  loginRateLimit,
  signupRateLimit,
  walletSignupRateLimit,
  walletLoginRateLimit,
  walletChallengeRateLimit,
  passwordResetRateLimit,
  googleAuthRateLimit,
  vaultWithdrawAuthRateLimit,
  createIpRateLimiter,
};
