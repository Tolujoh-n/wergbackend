const AbuseEvent = require('../models/AbuseEvent');
const { banUserById } = require('./userBanService');
const { setGasDripSettings } = require('./gasDripSettings');

const THRESHOLDS = {
  dripDenial: { count: 8, windowMs: 10 * 60 * 1000 },
  dripSuccessBurst: { count: 4, windowMs: 24 * 60 * 60 * 1000 },
  walletSignupSybil: { count: 5, windowMs: 60 * 60 * 1000 },
  jackpotAuthAbuse: { count: 10, windowMs: 10 * 60 * 1000 },
  doubleClaimAttempt: { count: 3, windowMs: 60 * 60 * 1000 },
};

async function recordAbuseEvent({ signal, userId, walletAddress, ip, meta }) {
  return AbuseEvent.create({
    signal,
    user: userId || undefined,
    walletAddress: walletAddress ? String(walletAddress).toLowerCase() : undefined,
    ip: ip || undefined,
    meta: meta || undefined,
  });
}

async function countRecent({ signal, userId, walletAddress, ip, windowMs }) {
  const since = new Date(Date.now() - windowMs);
  const q = { signal, createdAt: { $gte: since } };
  if (userId) q.user = userId;
  else if (walletAddress) q.walletAddress = String(walletAddress).toLowerCase();
  else if (ip) q.ip = ip;
  else return 0;
  return AbuseEvent.countDocuments(q);
}

async function maybeAutoBan(userId, reason, { signal, meta } = {}) {
  if (!userId) return { banned: false };
  try {
    const result = await banUserById(userId, { reason });
    await AbuseEvent.create({
      signal: signal || 'auto_ban',
      user: userId,
      banned: true,
      banReason: reason,
      meta,
    });
    return { banned: !result.alreadyBanned, alreadyBanned: result.alreadyBanned };
  } catch (e) {
    if (e.statusCode === 403) return { banned: false, skippedAdmin: true };
    console.warn('[abuseDetection] auto-ban failed:', e.message);
    return { banned: false, error: e.message };
  }
}

/**
 * Record a gas-drip denial; auto-ban if spam threshold hit.
 */
async function noteDripDenial({ userId, walletAddress, ip, code, meta }) {
  await recordAbuseEvent({
    signal: 'drip_denial',
    userId,
    walletAddress,
    ip,
    meta: { code, ...meta },
  });
  const t = THRESHOLDS.dripDenial;
  const byUser = userId
    ? await countRecent({ signal: 'drip_denial', userId, windowMs: t.windowMs })
    : 0;
  const byWallet = walletAddress
    ? await countRecent({
        signal: 'drip_denial',
        walletAddress,
        windowMs: t.windowMs,
      })
    : 0;
  if (byUser >= t.count || byWallet >= t.count) {
    return maybeAutoBan(userId, 'Auto/security: gas drip spam', {
      signal: 'drip_denial_ban',
      meta: { byUser, byWallet, code },
    });
  }
  return { banned: false };
}

/**
 * Record successful drip; if impossible burst, ban + kill drip.
 */
async function noteDripSuccess({ userId, walletAddress, ip, meta }) {
  await recordAbuseEvent({
    signal: 'drip_success',
    userId,
    walletAddress,
    ip,
    meta,
  });
  const t = THRESHOLDS.dripSuccessBurst;
  const n = await countRecent({
    signal: 'drip_success',
    userId,
    windowMs: t.windowMs,
  });
  if (n >= t.count) {
    try {
      await setGasDripSettings({ enabled: false });
    } catch (e) {
      console.warn('[abuseDetection] kill drip failed:', e.message);
    }
    return maybeAutoBan(userId, 'Auto/security: gas drip burst (kill switch)', {
      signal: 'drip_success_ban',
      meta: { count: n },
    });
  }
  return { banned: false };
}

/**
 * Wallet signup sybil by IP — ban the newest account when threshold hit.
 */
async function noteWalletSignup({ userId, ip, walletAddress }) {
  if (!ip) return { banned: false };
  await recordAbuseEvent({
    signal: 'wallet_signup',
    userId,
    walletAddress,
    ip,
  });
  const t = THRESHOLDS.walletSignupSybil;
  const n = await countRecent({ signal: 'wallet_signup', ip, windowMs: t.windowMs });
  if (n >= t.count) {
    return maybeAutoBan(userId, 'Auto/security: wallet signup sybil', {
      signal: 'wallet_signup_ban',
      meta: { ip, count: n },
    });
  }
  return { banned: false };
}

async function noteJackpotAuth({ userId, walletAddress, ip }) {
  await recordAbuseEvent({
    signal: 'jackpot_auth',
    userId,
    walletAddress,
    ip,
  });
  const t = THRESHOLDS.jackpotAuthAbuse;
  const n = await countRecent({ signal: 'jackpot_auth', userId, windowMs: t.windowMs });
  if (n >= t.count) {
    return maybeAutoBan(userId, 'Auto/security: jackpot auth spam', {
      signal: 'jackpot_auth_ban',
      meta: { count: n },
    });
  }
  return { banned: false };
}

async function noteDoubleClaimAttempt({ userId, walletAddress, ip, meta }) {
  await recordAbuseEvent({
    signal: 'double_claim_attempt',
    userId,
    walletAddress,
    ip,
    meta,
  });
  const t = THRESHOLDS.doubleClaimAttempt;
  const n = await countRecent({
    signal: 'double_claim_attempt',
    userId,
    windowMs: t.windowMs,
  });
  if (n >= t.count) {
    return maybeAutoBan(userId, 'Auto/security: jackpot double-claim attempt', {
      signal: 'double_claim_ban',
      meta: { count: n, ...meta },
    });
  }
  return { banned: false };
}

module.exports = {
  THRESHOLDS,
  recordAbuseEvent,
  noteDripDenial,
  noteDripSuccess,
  noteWalletSignup,
  noteJackpotAuth,
  noteDoubleClaimAttempt,
  maybeAutoBan,
};
