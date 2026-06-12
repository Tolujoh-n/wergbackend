/**
 * CORS allowlist for browser clients (frontend on Vercel, app.wergame.io, localhost, etc.).
 * Set CORS_ORIGINS in .env as comma-separated extra origins.
 */

const DEFAULT_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:8080',
  'https://wergame.io',
  'http://wergame.io',
  'https://www.wergame.io',
  'http://www.wergame.io',
  'https://app.wergame.io',
  'http://app.wergame.io',
  'https://www.app.wergame.io',
  'http://www.app.wergame.io',
  'https://wergtest-enn.vercel.app',
];

function parseEnvOrigins() {
  const raw = process.env.CORS_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostnameAllowed(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return h === 'wergame.io' || h.endsWith('.wergame.io') || h.endsWith('.vercel.app');
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  const list = [...DEFAULT_ORIGINS, ...parseEnvOrigins()];
  if (list.includes(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostnameAllowed(hostname);
  } catch {
    return false;
  }
}

function corsOptions() {
  return {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }
      console.warn('[cors] blocked origin:', origin);
      callback(new Error(`CORS not allowed for origin: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 204,
  };
}

/** Explicit headers (backup if proxy strips cors package output). */
function applyCorsHeaders(req, res, next) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ||
        'Content-Type, Authorization, X-Requested-With'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  next();
}

module.exports = { corsOptions, isAllowedOrigin, applyCorsHeaders, DEFAULT_ORIGINS };
