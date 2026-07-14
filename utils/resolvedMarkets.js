const Match = require('../models/Match');
const Poll = require('../models/Poll');
const { orderbookContractAddressLower } = require('./orderbookContractScope');

/** @type {Map<string, { set: Set<number>, at: number }>} */
const cacheByContract = new Map();
const CACHE_MS = 15_000;

function normContract(contractLower) {
  if (contractLower == null || contractLower === '') {
    return orderbookContractAddressLower() || '';
  }
  return String(contractLower).trim().toLowerCase();
}

/**
 * Chain market IDs that are fully done for a given WeRgame deployment.
 * Keyed by (contractAddress, marketId) so redeploys can reuse marketId 1..N safely.
 *
 * @param {string} [contractLower] defaults to current CONTRACT_ADDRESS
 * @returns {Promise<Set<number>>}
 */
async function getResolvedChainMarketIdSet(contractLower) {
  const c = normContract(contractLower);
  const now = Date.now();
  const hit = cacheByContract.get(c || '__none__');
  if (hit && now - hit.at < CACHE_MS) return hit.set;

  const contractClause = c
    ? { contractAddress: c }
    : {
        $or: [{ contractAddress: null }, { contractAddress: { $exists: false } }, { contractAddress: '' }],
      };

  const [resolvedMatches, resolvedPolls, activeMatches, activePolls] = await Promise.all([
    Match.find({ isResolved: true, marketId: { $ne: null }, ...contractClause })
      .select('marketId')
      .lean(),
    Poll.find({ isResolved: true, marketId: { $ne: null }, ...contractClause })
      .select('marketId')
      .lean(),
    Match.find({
      isResolved: { $ne: true },
      marketId: { $ne: null },
      status: { $nin: ['completed', 'locked'] },
      ...contractClause,
    })
      .select('marketId')
      .lean(),
    Poll.find({
      isResolved: { $ne: true },
      marketId: { $ne: null },
      status: { $nin: ['settled', 'locked'] },
      ...contractClause,
    })
      .select('marketId')
      .lean(),
  ]);

  const active = new Set();
  for (const row of [...activeMatches, ...activePolls]) {
    const id = Number(row.marketId);
    if (Number.isFinite(id)) active.add(id);
  }

  const set = new Set();
  for (const row of [...resolvedMatches, ...resolvedPolls]) {
    const id = Number(row.marketId);
    if (!Number.isFinite(id)) continue;
    // Still an open market on THIS contract sharing the id → keep trading/reserve alive.
    if (active.has(id)) continue;
    set.add(id);
  }

  cacheByContract.set(c || '__none__', { set, at: now });
  return set;
}

/** @param {number|string} chainMarketId @param {string} [contractLower] */
async function isChainMarketResolved(chainMarketId, contractLower) {
  const id = Number(chainMarketId);
  if (!Number.isFinite(id)) return false;
  const set = await getResolvedChainMarketIdSet(contractLower);
  return set.has(id);
}

function invalidateResolvedMarketCache() {
  cacheByContract.clear();
}

module.exports = {
  getResolvedChainMarketIdSet,
  isChainMarketResolved,
  invalidateResolvedMarketCache,
};
