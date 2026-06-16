const IpRateLimit = require('../models/IpRateLimit');

/**
 * Sliding-window rate limit backed by MongoDB (works across restarts / single-node deploys).
 */
async function consumeRateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const windowStartMs = Math.floor(now / windowMs) * windowMs;
  const bucketKey = `${key}:${windowStartMs}`;
  const expiresAt = new Date(windowStartMs + windowMs + 60_000);

  const doc = await IpRateLimit.findOneAndUpdate(
    { key: bucketKey },
    {
      $setOnInsert: { windowStart: new Date(windowStartMs), expiresAt },
      $inc: { count: 1 },
    },
    { upsert: true, new: true }
  );

  if (doc.count > limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - now) / 1000));
    const err = new Error('RATE_LIMIT_EXCEEDED');
    err.statusCode = 429;
    err.retryAfterSeconds = retryAfterSeconds;
    err.limit = limit;
    err.windowMs = windowMs;
    throw err;
  }

  return {
    remaining: Math.max(0, limit - doc.count),
    retryAfterSeconds: Math.ceil((windowStartMs + windowMs - now) / 1000),
  };
}

module.exports = { consumeRateLimit };
