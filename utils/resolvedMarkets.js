const Match = require('../models/Match');
const Poll = require('../models/Poll');

/** @type {{ set: Set<number>, at: number } | null} */
let cache = null;
const CACHE_MS = 15_000;

/**
 * Chain market IDs for matches/polls marked resolved in the DB.
 * @returns {Promise<Set<number>>}
 */
async function getResolvedChainMarketIdSet() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.set;

  const [matches, polls] = await Promise.all([
    Match.find({ isResolved: true, marketId: { $ne: null } }).select('marketId').lean(),
    Poll.find({ isResolved: true, marketId: { $ne: null } }).select('marketId').lean(),
  ]);
  const set = new Set();
  for (const row of [...matches, ...polls]) {
    const id = Number(row.marketId);
    if (Number.isFinite(id)) set.add(id);
  }
  cache = { set, at: now };
  return set;
}

function invalidateResolvedMarketCache() {
  cache = null;
}

module.exports = { getResolvedChainMarketIdSet, invalidateResolvedMarketCache };
