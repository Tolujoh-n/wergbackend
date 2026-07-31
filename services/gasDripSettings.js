const { ethers } = require('ethers');
const Settings = require('../models/Settings');

/** Absolute ceiling — admin cannot configure a single drip above this (USD). */
const HARD_MAX_USD_PER_DRIP = 0.5;

const DEFAULT_GAS_DRIP = {
  enabled: true,
  freeUsd: 0.1,
  boostUsd: 0.2,
  marketUsd: 0.25,
  freeCooldownDays: 7,
  /** Hours between boost drips (per user + per wallet). */
  boostCooldownHours: 24,
  /** Hours between market drips (per user + per wallet). */
  marketCooldownHours: 24,
  /** Minimum hours between ANY drip to the same wallet (all play types). */
  walletCooldownHours: 6,
  /** Max successful drips per user per UTC day (all types combined). */
  maxDripsPerUserPerDay: 3,
  /** Max successful drips per wallet per UTC day. */
  maxDripsPerWalletPerDay: 2,
  /** Max USD worth dripped per user per UTC day. */
  maxUsdPerUserPerDay: 0.75,
  /** Only drip to the user's primary User.walletAddress (blocks multi-wallet farming). */
  primaryWalletOnly: true,
  ethUsdFallback: 3000,
};

function clampUsd(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return fallback;
  return Math.min(v, HARD_MAX_USD_PER_DRIP);
}

function normalizeGasDripSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: v.enabled !== false && v.enabled !== 'false',
    freeUsd: clampUsd(v.freeUsd, DEFAULT_GAS_DRIP.freeUsd),
    boostUsd: clampUsd(v.boostUsd, DEFAULT_GAS_DRIP.boostUsd),
    marketUsd: clampUsd(v.marketUsd, DEFAULT_GAS_DRIP.marketUsd),
    freeCooldownDays: Math.max(0, parseInt(v.freeCooldownDays, 10) || DEFAULT_GAS_DRIP.freeCooldownDays),
    boostCooldownHours: Math.max(
      1,
      parseInt(v.boostCooldownHours, 10) || DEFAULT_GAS_DRIP.boostCooldownHours
    ),
    marketCooldownHours: Math.max(
      1,
      parseInt(v.marketCooldownHours, 10) || DEFAULT_GAS_DRIP.marketCooldownHours
    ),
    walletCooldownHours: Math.max(
      1,
      parseInt(v.walletCooldownHours, 10) || DEFAULT_GAS_DRIP.walletCooldownHours
    ),
    maxDripsPerUserPerDay: Math.max(
      1,
      parseInt(v.maxDripsPerUserPerDay, 10) || DEFAULT_GAS_DRIP.maxDripsPerUserPerDay
    ),
    maxDripsPerWalletPerDay: Math.max(
      1,
      parseInt(v.maxDripsPerWalletPerDay, 10) || DEFAULT_GAS_DRIP.maxDripsPerWalletPerDay
    ),
    maxUsdPerUserPerDay: Math.max(
      0.01,
      Math.min(5, Number(v.maxUsdPerUserPerDay) || DEFAULT_GAS_DRIP.maxUsdPerUserPerDay)
    ),
    primaryWalletOnly: v.primaryWalletOnly !== false && v.primaryWalletOnly !== 'false',
    ethUsdFallback: Math.max(1, Number(v.ethUsdFallback) || DEFAULT_GAS_DRIP.ethUsdFallback),
  };
}

async function getGasDripSettings() {
  const s = await Settings.findOne({ key: 'gasDripSettings' }).lean();
  return normalizeGasDripSettings(s?.value);
}

async function setGasDripSettings(partial) {
  const cur = await getGasDripSettings();
  const next = normalizeGasDripSettings({ ...cur, ...partial });
  await Settings.findOneAndUpdate(
    { key: 'gasDripSettings' },
    {
      key: 'gasDripSettings',
      value: next,
      description:
        'Relayer gas drip: USD amounts, cooldowns (all play types), daily caps, kill switch',
    },
    { upsert: true, new: true }
  );
  return next;
}

async function getEthUsdPrice(fallback = DEFAULT_GAS_DRIP.ethUsdFallback) {
  try {
    const cached = await Settings.findOne({ key: 'ethUsdPrice' }).lean();
    const age = cached?.updatedAt ? Date.now() - new Date(cached.updatedAt).getTime() : Infinity;
    if (cached?.value?.usd > 0 && age < 15 * 60 * 1000) {
      return Number(cached.value.usd);
    }
  } catch {
    /* ignore */
  }

  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(8000) }
    );
    if (response.ok) {
      const data = await response.json();
      const usd = data?.ethereum?.usd;
      if (typeof usd === 'number' && usd > 0) {
        await Settings.findOneAndUpdate(
          { key: 'ethUsdPrice' },
          {
            key: 'ethUsdPrice',
            value: { usd, lastUpdated: new Date() },
            description: 'Cached ETH/USD for gas drip conversion',
          },
          { upsert: true, new: true }
        ).catch(() => {});
        return usd;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const s = await getGasDripSettings();
    return s.ethUsdFallback || fallback;
  } catch {
    return fallback;
  }
}

function usdToEth(usd, ethUsd) {
  const u = Number(usd) || 0;
  const px = Number(ethUsd) || DEFAULT_GAS_DRIP.ethUsdFallback;
  if (!(u > 0) || !(px > 0)) return 0;
  return u / px;
}

/**
 * @param {'free'|'boost'|'market'} playType
 */
async function resolveDripAmountWei(playType) {
  const settings = await getGasDripSettings();
  const ethUsd = await getEthUsdPrice(settings.ethUsdFallback);
  const key =
    playType === 'boost' ? 'boostUsd' : playType === 'market' ? 'marketUsd' : 'freeUsd';
  const usd = Math.min(Number(settings[key]) || 0, HARD_MAX_USD_PER_DRIP);
  const eth = usdToEth(usd, ethUsd);
  const ethClamped = Math.max(eth, 0.00001);
  return {
    settings,
    ethUsd,
    usd,
    eth: ethClamped,
    amountWei: ethers.parseEther(ethClamped.toFixed(8)),
    minBalanceWei: ethers.parseEther(Math.max(ethClamped * 0.4, 0.00002).toFixed(8)),
  };
}

function cooldownMsForPlayType(playType, settings) {
  const s = settings || DEFAULT_GAS_DRIP;
  if (playType === 'free') {
    const days = Number(s.freeCooldownDays) || DEFAULT_GAS_DRIP.freeCooldownDays;
    return Math.max(0, days) * 24 * 60 * 60 * 1000;
  }
  if (playType === 'boost') {
    return (Number(s.boostCooldownHours) || DEFAULT_GAS_DRIP.boostCooldownHours) * 60 * 60 * 1000;
  }
  return (Number(s.marketCooldownHours) || DEFAULT_GAS_DRIP.marketCooldownHours) * 60 * 60 * 1000;
}

function lastDripFieldForPlayType(playType) {
  if (playType === 'free') return 'lastFreeGasDripAt';
  if (playType === 'boost') return 'lastBoostGasDripAt';
  return 'lastMarketGasDripAt';
}

function dripEligibleFromLast(lastAt, cooldownMs) {
  if (!(cooldownMs > 0)) return { eligible: true, nextEligibleAt: null, remainingMs: 0 };
  const last = lastAt ? new Date(lastAt).getTime() : 0;
  if (!last) return { eligible: true, nextEligibleAt: null, remainingMs: 0 };
  const next = last + cooldownMs;
  const now = Date.now();
  if (now >= next) return { eligible: true, nextEligibleAt: null, remainingMs: 0 };
  return {
    eligible: false,
    nextEligibleAt: new Date(next).toISOString(),
    remainingMs: next - now,
  };
}

/** @deprecated use dripEligibleFromLast + cooldownMsForPlayType — kept for callers */
function freeDripEligible(user, settings) {
  const ms = cooldownMsForPlayType('free', settings);
  return dripEligibleFromLast(user?.lastFreeGasDripAt, ms);
}

function utcDayStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

module.exports = {
  HARD_MAX_USD_PER_DRIP,
  DEFAULT_GAS_DRIP,
  normalizeGasDripSettings,
  getGasDripSettings,
  setGasDripSettings,
  getEthUsdPrice,
  usdToEth,
  resolveDripAmountWei,
  freeDripEligible,
  cooldownMsForPlayType,
  lastDripFieldForPlayType,
  dripEligibleFromLast,
  utcDayStart,
};
