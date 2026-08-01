const mongoose = require('mongoose');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Prediction = require('../models/Prediction');
const { getEventClaimStats } = require('./eventClaimStats');

const ROUND = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

function emptyBucket() {
  return {
    total: 0,
    claimed: 0,
    unclaimed: 0,
    claimedCount: 0,
    unclaimedCount: 0,
    winnerCount: 0,
  };
}

function emptyParticipants() {
  return { free: 0, boost: 0, market: 0, total: 0 };
}

/**
 * Unique participants per play type for one event.
 */
async function participantCountsForEvent(kind, eventId) {
  const eventFilter = kind === 'match' ? { match: eventId } : { poll: eventId };
  const rows = await Prediction.aggregate([
    { $match: { ...eventFilter, type: { $in: ['free', 'boost', 'market'] } } },
    {
      $group: {
        _id: { type: '$type', user: '$user' },
      },
    },
    {
      $group: {
        _id: '$_id.type',
        users: { $sum: 1 },
      },
    },
  ]);
  const out = emptyParticipants();
  const userSets = { free: 0, boost: 0, market: 0 };
  for (const r of rows) {
    const t = String(r._id || '');
    if (t === 'free' || t === 'boost' || t === 'market') userSets[t] = Number(r.users) || 0;
  }
  out.free = userSets.free;
  out.boost = userSets.boost;
  out.market = userSets.market;
  // Distinct users across all types for this event
  const all = await Prediction.aggregate([
    { $match: { ...eventFilter, type: { $in: ['free', 'boost', 'market'] } } },
    { $group: { _id: '$user' } },
    { $count: 'n' },
  ]);
  out.total = all[0]?.n || 0;
  return out;
}

function buildDateFilter(from, to) {
  const q = {};
  if (from || to) {
    q.date = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) q.date.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        q.date.$lte = d;
      }
    }
    if (!Object.keys(q.date).length) delete q.date;
  }
  return q;
}

/**
 * Market P&L (house / liquidity view):
 * net user buy volume across options minus market payouts owed (claimed + unclaimed).
 * Positive = profit (green), negative = loss (red).
 * Fees are reported separately and also included in `marketPnLWithFees`.
 */
function computeMarketPnL(stats) {
  const volume = Number(stats?.marketVolume?.totalNetBuy) || 0;
  const claimsTotal = Number(stats?.claims?.market?.total) || 0;
  const fees = Number(stats?.pools?.marketPlatformFees) || 0;
  const pnl = ROUND(volume - claimsTotal);
  return {
    volumeNetBuy: ROUND(volume),
    claimsTotal: ROUND(claimsTotal),
    fees: ROUND(fees),
    marketPnL: pnl,
    marketPnLWithFees: ROUND(pnl + fees),
  };
}

function rowFromStats(kind, event, stats, participants) {
  const pnl = computeMarketPnL(stats);
  const claims = stats.claims || {};
  const free = claims.free || emptyBucket();
  const boost = claims.boost || emptyBucket();
  const market = claims.market || emptyBucket();
  const grand = claims.grandTotal || {
    total: ROUND(free.total + boost.total + market.total),
    claimed: ROUND(free.claimed + boost.claimed + market.claimed),
    unclaimed: ROUND(free.unclaimed + boost.unclaimed + market.unclaimed),
  };
  const playGrand = ROUND(
    (Number(participants?.free) || 0) +
      (Number(participants?.boost) || 0) +
      (Number(participants?.market) || 0)
  );

  return {
    id: String(event._id),
    kind,
    label:
      kind === 'match'
        ? `${event.teamA || 'Team A'} vs ${event.teamB || 'Team B'}`
        : String(event.question || 'Poll'),
    date: event.date || event.createdAt || null,
    status: event.status || null,
    isResolved: !!event.isResolved,
    marketId: event.marketId ?? null,
    contractAddress: event.contractAddress || null,
    participants: {
      free: participants?.free || 0,
      boost: participants?.boost || 0,
      market: participants?.market || 0,
      /** Unique users who played any mode */
      unique: participants?.total || 0,
      /** Sum of free+boost+market participant counts (may double-count cross-mode) */
      sumModes: playGrand,
    },
    claims: {
      free,
      boost,
      market,
      claimed: ROUND(grand.claimed),
      unclaimed: ROUND(grand.unclaimed),
      unclaimedFree: ROUND(free.unclaimed),
      unclaimedBoost: ROUND(boost.unclaimed),
      unclaimedMarket: ROUND(market.unclaimed),
      claimTotal: ROUND(grand.claimed + grand.unclaimed),
      grandTotal: ROUND(grand.total),
    },
    fees: {
      platform: ROUND(stats.pools?.platformFees),
      market: ROUND(stats.pools?.marketPlatformFees),
      total: ROUND((stats.pools?.platformFees || 0) + (stats.pools?.marketPlatformFees || 0)),
    },
    pools: {
      freeJackpot: ROUND(stats.pools?.freeJackpotPool),
      boost: ROUND(stats.pools?.boostPool),
    },
    marketVolume: ROUND(stats.marketVolume?.totalNetBuy),
    marketPnL: pnl.marketPnL,
    marketPnLWithFees: pnl.marketPnLWithFees,
  };
}

function sumRows(rows) {
  const z = {
    participants: emptyParticipants(),
    participantsUnique: 0,
    participantsSumModes: 0,
    freeClaimed: 0,
    freeUnclaimed: 0,
    boostClaimed: 0,
    boostUnclaimed: 0,
    marketClaimed: 0,
    marketUnclaimed: 0,
    claimed: 0,
    unclaimed: 0,
    claimTotal: 0,
    grandTotal: 0,
    marketVolume: 0,
    marketPnL: 0,
    marketPnLWithFees: 0,
    feesPlatform: 0,
    feesMarket: 0,
    feesTotal: 0,
    freeJackpotPool: 0,
    boostPool: 0,
    eventCount: rows.length,
  };
  for (const r of rows) {
    z.participants.free += r.participants.free;
    z.participants.boost += r.participants.boost;
    z.participants.market += r.participants.market;
    z.participantsUnique += r.participants.unique;
    z.participantsSumModes += r.participants.sumModes;
    z.freeClaimed += r.claims.free.claimed;
    z.freeUnclaimed += r.claims.free.unclaimed;
    z.boostClaimed += r.claims.boost.claimed;
    z.boostUnclaimed += r.claims.boost.unclaimed;
    z.marketClaimed += r.claims.market.claimed;
    z.marketUnclaimed += r.claims.market.unclaimed;
    z.claimed += r.claims.claimed;
    z.unclaimed += r.claims.unclaimed;
    z.claimTotal += r.claims.claimTotal;
    z.grandTotal += r.claims.grandTotal;
    z.marketVolume += r.marketVolume;
    z.marketPnL += r.marketPnL;
    z.marketPnLWithFees += r.marketPnLWithFees;
    z.feesPlatform += r.fees.platform;
    z.feesMarket += r.fees.market;
    z.feesTotal += r.fees.total;
    z.freeJackpotPool += r.pools.freeJackpot;
    z.boostPool += r.pools.boost;
  }
  for (const k of Object.keys(z)) {
    if (typeof z[k] === 'number' && k !== 'eventCount' && k !== 'participantsUnique' && k !== 'participantsSumModes') {
      if (k === 'participants') continue;
      z[k] = ROUND(z[k]);
    }
  }
  z.participants.free = ROUND(z.participants.free);
  z.participants.boost = ROUND(z.participants.boost);
  z.participants.market = ROUND(z.participants.market);
  z.participants.total = ROUND(z.participantsUnique);
  return z;
}

/**
 * Data Room list for admin / superadmin.
 * @param {{ kind?: 'match'|'poll'|'all', from?: string, to?: string, status?: string, resolved?: string, q?: string, limit?: number }} opts
 */
async function getDataRoomRows(opts = {}) {
  const kindFilter = String(opts.kind || 'all').toLowerCase();
  const dateQ = buildDateFilter(opts.from, opts.to);
  const status = opts.status && opts.status !== 'all' ? String(opts.status) : null;
  const resolved =
    opts.resolved === 'true' || opts.resolved === true
      ? true
      : opts.resolved === 'false' || opts.resolved === false
        ? false
        : null;
  const qText = String(opts.q || '').trim();
  const limit = Math.min(500, Math.max(1, parseInt(opts.limit, 10) || 200));

  const matchQuery = { ...dateQ };
  const pollQuery = { ...dateQ };
  if (status) {
    matchQuery.status = status;
    pollQuery.status = status;
  }
  if (resolved === true) {
    matchQuery.isResolved = true;
    pollQuery.isResolved = true;
  } else if (resolved === false) {
    matchQuery.isResolved = { $ne: true };
    pollQuery.isResolved = { $ne: true };
  }
  if (qText) {
    const rx = new RegExp(qText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    matchQuery.$or = [{ teamA: rx }, { teamB: rx }];
    pollQuery.question = rx;
  }

  const jobs = [];
  if (kindFilter === 'all' || kindFilter === 'match' || kindFilter === 'matches') {
    jobs.push(
      Match.find(matchQuery)
        .sort({ date: -1, createdAt: -1 })
        .limit(limit)
        .lean()
        .then((rows) => rows.map((e) => ({ kind: 'match', event: e })))
    );
  }
  if (kindFilter === 'all' || kindFilter === 'poll' || kindFilter === 'polls') {
    jobs.push(
      Poll.find(pollQuery)
        .sort({ date: -1, createdAt: -1 })
        .limit(limit)
        .lean()
        .then((rows) => rows.map((e) => ({ kind: 'poll', event: e })))
    );
  }

  const nested = await Promise.all(jobs);
  let events = nested.flat();
  events.sort((a, b) => {
    const da = new Date(a.event.date || a.event.createdAt || 0).getTime();
    const db = new Date(b.event.date || b.event.createdAt || 0).getTime();
    return db - da;
  });
  events = events.slice(0, limit);

  const rows = [];
  // Sequential to avoid hammering Mongo; still fine for hundreds of events.
  for (const { kind, event } of events) {
    try {
      const [stats, participants] = await Promise.all([
        getEventClaimStats(kind, event._id),
        participantCountsForEvent(kind, event._id),
      ]);
      rows.push(rowFromStats(kind, event, stats, participants));
    } catch (e) {
      console.warn('[dataRoom]', kind, String(event._id), e.message || e);
    }
  }

  return {
    rows,
    totals: sumRows(rows),
    meta: {
      kind: kindFilter,
      from: opts.from || null,
      to: opts.to || null,
      status: status || 'all',
      resolved: resolved == null ? 'all' : resolved,
      q: qText || null,
      count: rows.length,
      note:
        'Market P&L = net user buy volume − market payouts (claimed + unclaimed). Positive = profit. marketPnLWithFees adds market platform fees.',
    },
  };
}

module.exports = {
  getDataRoomRows,
  participantCountsForEvent,
  computeMarketPnL,
};
