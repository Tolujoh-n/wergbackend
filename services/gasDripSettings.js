const { ethers } = require('ethers');
const Settings = require('../models/Settings');

const DEFAULT_GAS_DRIP = {
  freeUsd: 0.1,
  boostUsd: 0.2,
  marketUsd: 0.25,
  freeCooldownDays: 7,
  /** Fallback ETH/USD if live price unavailable */
  ethUsdFallback: 3000,
};

function normalizeGasDripSettings(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    freeUsd: Math.max(0, Number(v.freeUsd) || DEFAULT_GAS_DRIP.freeUsd),
    boostUsd: Math.max(0, Number(v.boostUsd) || DEFAULT_GAS_DRIP.boostUsd),
    marketUsd: Math.max(0, Number(v.marketUsd) || DEFAULT_GAS_DRIP.marketUsd),
    freeCooldownDays: Math.max(0, parseInt(v.freeCooldownDays, 10) || DEFAULT_GAS_DRIP.freeCooldownDays),
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
        'Relayer gas drip amounts (USD worth of ETH) per play type + free drip cooldown days',
    },
    { upsert: true, new: true }
  );
  return next;
}

/**
 * Best-effort ETH/USD. Prefer CoinGecko; fall back to cached Settings / constant.
 * (EthPrice model currently stores USDC≈1 — not used for ETH conversion.)
 */
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
  const usd = settings[key];
  const eth = usdToEth(usd, ethUsd);
  // Floor tiny drips; never send dust that can't cover gas
  const ethClamped = Math.max(eth, 0.00001);
  return {
    settings,
    ethUsd,
    usd,
    eth: ethClamped,
    amountWei: ethers.parseEther(ethClamped.toFixed(8)),
    // Consider wallet funded if it has ~half a drip or the legacy min
    minBalanceWei: ethers.parseEther(Math.max(ethClamped * 0.4, 0.00002).toFixed(8)),
  };
}

function freeDripEligible(user, settings) {
  const days = Number(settings?.freeCooldownDays) || DEFAULT_GAS_DRIP.freeCooldownDays;
  if (!(days > 0)) return { eligible: true, nextEligibleAt: null, remainingMs: 0 };
  const last = user?.lastFreeGasDripAt ? new Date(user.lastFreeGasDripAt).getTime() : 0;
  if (!last) return { eligible: true, nextEligibleAt: null, remainingMs: 0 };
  const next = last + days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (now >= next) return { eligible: true, nextEligibleAt: null, remainingMs: 0 };
  return {
    eligible: false,
    nextEligibleAt: new Date(next).toISOString(),
    remainingMs: next - now,
  };
}

module.exports = {
  DEFAULT_GAS_DRIP,
  normalizeGasDripSettings,
  getGasDripSettings,
  setGasDripSettings,
  getEthUsdPrice,
  usdToEth,
  resolveDripAmountWei,
  freeDripEligible,
};
