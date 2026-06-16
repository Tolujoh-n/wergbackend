/**
 * Resolve client IP behind reverse proxies (Hostinger, Cloudflare, etc.).
 */
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf && String(cf).trim()) return String(cf).trim();

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }

  const xri = req.headers['x-real-ip'];
  if (xri && String(xri).trim()) return String(xri).trim();

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

module.exports = { getClientIp };
