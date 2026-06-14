const User = require('../models/User');
const Settings = require('../models/Settings');
const WalletLink = require('../models/WalletLink');
const { ethers } = require('ethers');
const { getJsonRpcProvider } = require('../utils/chainConfig');
const { anyWalletHoldsToken, normalizeTokenStandard } = require('../utils/tokenHoldings');

function startOfUtcDay(d = new Date()) {
  const t = new Date(d);
  t.setUTCHours(0, 0, 0, 0);
  return t;
}

async function getSettingValue(key, fallback) {
  const s = await Settings.findOne({ key }).lean();
  if (!s || s.value == null) return fallback;
  return s.value;
}

async function getDailyFreeTicketsLimit() {
  const legacy = await Settings.findOne({ key: 'dailyFreePlayLimit' }).lean();
  const modern = await Settings.findOne({ key: 'dailyFreeTickets' }).lean();
  const v = modern?.value ?? legacy?.value;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

async function getNftTicketBonuses() {
  const s = await Settings.findOne({ key: 'nftTicketBonuses' }).lean();
  const list = s?.value;
  return Array.isArray(list) ? list : [];
}

async function getGoldenTicketBoostRanges() {
  const s = await Settings.findOne({ key: 'goldenTicketBoostRanges' }).lean();
  const list = s?.value;
  return Array.isArray(list) ? list : [];
}

async function resetDailyTicketsIfNeeded(user) {
  const today = startOfUtcDay();
  const last = user.lastTicketDate ? startOfUtcDay(new Date(user.lastTicketDate)) : null;
  if (!last || last.getTime() < today.getTime()) {
    const limit = await getDailyFreeTicketsLimit();
    user.tickets = limit;
    user.lastTicketDate = today;
    await user.save();
  }
  return user;
}

async function userLinkedWallets(userId) {
  const links = await WalletLink.find({ user: userId }).select('walletAddress').lean();
  return (links || []).map((l) => l.walletAddress).filter(Boolean);
}

function mergeWalletList(linked, additional = []) {
  const set = new Set();
  for (const w of [...(linked || []), ...(additional || [])]) {
    const s = String(w || '').trim().toLowerCase();
    if (s && ethers.isAddress(s)) set.add(s);
  }
  return [...set];
}

async function nftBonusTicketsForUser(userId) {
  const list = await getNftBonusesForUser(userId);
  return list.reduce((sum, n) => sum + (n.holds ? (n.dailyTickets || 0) : 0), 0);
}

/**
 * Admin-configured NFT rows with optional on-chain hold flag for linked wallets.
 * @param {string|null} userId
 * @returns {Promise<Array<object>>}
 */
async function getNftBonusesForUser(userId = null, { additionalWallets = [] } = {}) {
  const bonuses = await getNftTicketBonuses();
  if (!bonuses.length) return [];

  let linkedWallets = [];
  let wallets = [];
  let provider = null;
  if (userId) {
    linkedWallets = await userLinkedWallets(userId);
    wallets = mergeWalletList(linkedWallets, additionalWallets);
    if (wallets.length) {
      try {
        provider = getJsonRpcProvider();
      } catch (e) {
        console.warn('ticketService: RPC unavailable for NFT verification', e?.message || e);
        provider = null;
      }
    }
  }

  const linkedSet = new Set(linkedWallets.map((w) => String(w).toLowerCase()));

  const rows = await Promise.all(
    bonuses.map(async (cfg) => {
      const perNft = Math.max(0, parseInt(cfg.dailyTickets, 10) || 0);
      let holds = false;
      let holdsOnConnectedOnly = false;
      if (userId && provider) {
        if (linkedWallets.length) {
          holds = await anyWalletHoldsToken(linkedWallets, cfg, provider);
        }
        if (!holds && additionalWallets?.length) {
          const extraOnly = mergeWalletList([], additionalWallets).filter((w) => !linkedSet.has(w));
          if (extraOnly.length) {
            holdsOnConnectedOnly = await anyWalletHoldsToken(extraOnly, cfg, provider);
          }
        }
      }
      return {
        id: cfg.id,
        name: cfg.name || '',
        contractAddress: cfg.contractAddress || '',
        imageUrl: cfg.imageUrl || '',
        dailyTickets: perNft,
        link: cfg.link || '',
        tokenStandard: normalizeTokenStandard(cfg),
        tokenId: cfg.tokenId != null && cfg.tokenId !== '' ? String(cfg.tokenId) : '',
        holds: userId ? holds : null,
        holdsOnConnectedOnly: userId ? holdsOnConnectedOnly : false,
        verifiedOnChain: !!(userId && provider && (linkedWallets.length || additionalWallets?.length)),
      };
    })
  );
  return rows;
}

/** Admin-configured rows only (no RPC) — for instant UI before on-chain verification. */
async function getNftBonusesConfigRows() {
  const bonuses = await getNftTicketBonuses();
  return bonuses.map((cfg, i) => ({
    id: cfg.id || `nft-bonus-${i}`,
    name: cfg.name || '',
    contractAddress: cfg.contractAddress || '',
    imageUrl: cfg.imageUrl || '',
    dailyTickets: Math.max(0, parseInt(cfg.dailyTickets, 10) || 0),
    link: cfg.link || '',
    tokenStandard: normalizeTokenStandard(cfg),
    tokenId: cfg.tokenId != null && cfg.tokenId !== '' ? String(cfg.tokenId) : '',
    holds: null,
    holdsOnConnectedOnly: false,
    verifiedOnChain: false,
  }));
}

/**
 * @returns {{ normalTickets: number, goldenTickets: number, nftBonusToday: number, dailyLimit: number, totalSpendable: number }}
 */
async function getTicketBalances(userId, { additionalWallets = [] } = {}) {
  let user = await User.findById(userId);
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  try {
    const { processGrantsForUser } = require('./goldenTicketDailyGrantService');
    await processGrantsForUser(userId);
  } catch (e) {
    console.error('goldenTicketDailyGrant process', e.message);
  }
  user = await User.findById(userId);
  user = await resetDailyTicketsIfNeeded(user);
  const nftBonusList = await getNftBonusesForUser(userId, { additionalWallets });
  const nftBonus = nftBonusList.reduce((s, n) => s + (n.holds ? (n.dailyTickets || 0) : 0), 0);
  const dailyLimit = await getDailyFreeTicketsLimit();
  const normalTickets = Math.max(0, (user.tickets || 0) + nftBonus);
  const goldenTickets = Math.max(0, user.goldenTickets || 0);
  return {
    normalTickets,
    goldenTickets,
    nftBonusToday: nftBonus,
    dailyLimit,
    totalSpendable: normalTickets + goldenTickets,
    nftBonuses: nftBonusList,
  };
}

/**
 * Deduct tickets: golden first or normal first? User said both spendable — use golden last to preserve accumulation value, or golden first?
 * Prefer spend normal daily tickets first, then golden.
 */
async function deductTickets(userId, amount) {
  const balances = await getTicketBalances(userId);
  if (balances.totalSpendable < amount) {
    const err = new Error('Insufficient tickets');
    err.statusCode = 400;
    err.details = balances;
    throw err;
  }

  let user = await User.findById(userId);
  const nftBonus = balances.nftBonusToday;
  const dailyBase = Math.max(0, (user.tickets || 0));
  const normalAvailable = dailyBase + nftBonus;

  let remaining = amount;
  let fromNormal = Math.min(remaining, normalAvailable);
  remaining -= fromNormal;
  const fromGolden = remaining;

  if (fromNormal > 0) {
    const deductFromDaily = Math.min(fromNormal, dailyBase);
    user.tickets = Math.max(0, dailyBase - deductFromDaily);
    await user.save();
  }
  if (fromGolden > 0) {
    user = await User.findById(userId);
    user.goldenTickets = Math.max(0, (user.goldenTickets || 0) - fromGolden);
    await user.save();
  }

  return { fromNormal, fromGolden };
}

function goldenTicketsForBoostAmount(ranges, stakeUsdc) {
  const amt = Number(stakeUsdc) || 0;
  if (amt <= 0 || !ranges?.length) return 0;
  for (const r of ranges) {
    const min = Number(r.minUsdc) || 0;
    const maxRaw = r.maxUsdc;
    const max =
      maxRaw == null || maxRaw === ''
        ? Infinity
        : Number.isFinite(Number(maxRaw))
          ? Number(maxRaw)
          : Infinity;
    const tickets = parseInt(r.tickets, 10) || 0;
    if (amt >= min && amt <= max) return tickets;
  }
  return 0;
}

async function awardGoldenTickets(userId, count) {
  if (!count || count <= 0) return;
  await User.findByIdAndUpdate(userId, { $inc: { goldenTickets: count } });
}

module.exports = {
  getDailyFreeTicketsLimit,
  getNftTicketBonuses,
  getNftBonusesConfigRows,
  getGoldenTicketBoostRanges,
  getTicketBalances,
  deductTickets,
  goldenTicketsForBoostAmount,
  awardGoldenTickets,
  resetDailyTicketsIfNeeded,
  nftBonusTicketsForUser,
  getNftBonusesForUser,
};
