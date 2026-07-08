const mongoose = require('mongoose');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Prediction = require('../models/Prediction');
const OrderbookFill = require('../models/OrderbookFill');

const ROUND = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

function sumClaimBucket(rows, { amountField, claimedField }) {
  let total = 0;
  let claimed = 0;
  let unclaimed = 0;
  let claimedCount = 0;
  let unclaimedCount = 0;
  for (const p of rows) {
    const amt = Number(p[amountField]) || 0;
    if (!(amt > 0)) continue;
    total += amt;
    if (p[claimedField]) {
      claimed += amt;
      claimedCount += 1;
    } else {
      unclaimed += amt;
      unclaimedCount += 1;
    }
  }
  return {
    total: ROUND(total),
    claimed: ROUND(claimed),
    unclaimed: ROUND(unclaimed),
    claimedCount,
    unclaimedCount,
    winnerCount: rows.filter((p) => (Number(p[amountField]) || 0) > 0).length,
  };
}

function getOptionKeysForEvent(event, kind) {
  if (kind === 'match') {
    const keys = ['TeamA', 'TeamB'];
    if (event.drawEnabled !== false) keys.push('Draw');
    return keys;
  }
  if (event.optionType === 'options' && Array.isArray(event.options) && event.options.length) {
    return event.options.map((o) => String(o.text || '').trim()).filter(Boolean);
  }
  return ['YES', 'NO'];
}

function optionLabel(optionKey, event, kind) {
  const k = String(optionKey || '').trim();
  if (kind === 'match') {
    if (k === 'TeamA') return event.teamA || 'Team A';
    if (k === 'TeamB') return event.teamB || 'Team B';
    if (k === 'Draw') return 'Draw';
    return k;
  }
  return k;
}

async function aggregateNetUserBuyFromFills({ kind, eventId, chainMarketId }) {
  const eventField = kind === 'match' ? 'match' : 'poll';
  const oid = new mongoose.Types.ObjectId(eventId);
  const baseMatch = {
    takerIsMarketMaker: { $ne: true },
    [eventField]: oid,
  };

  let rows = await OrderbookFill.aggregate([
    { $match: baseMatch },
    {
      $group: {
        _id: '$optionKey',
        netBuy: {
          $sum: {
            $cond: [{ $eq: ['$takerDirection', 'buy'] }, '$notional', { $multiply: ['$notional', -1] }],
          },
        },
      },
    },
  ]);

  if (rows.length === 0 && chainMarketId != null && Number.isFinite(Number(chainMarketId))) {
    rows = await OrderbookFill.aggregate([
      {
        $match: {
          chainMarketId: Number(chainMarketId),
          takerIsMarketMaker: { $ne: true },
        },
      },
      {
        $group: {
          _id: '$optionKey',
          netBuy: {
            $sum: {
              $cond: [{ $eq: ['$takerDirection', 'buy'] }, '$notional', { $multiply: ['$notional', -1] }],
            },
          },
        },
      },
    ]);
  }

  const byOptionKey = {};
  for (const r of rows) {
    const k = String(r._id || '').trim();
    if (!k) continue;
    byOptionKey[k] = ROUND(Math.max(0, Number(r.netBuy) || 0));
  }
  return byOptionKey;
}

async function aggregateAmmNetBuy({ eventFilter }) {
  const rows = await Prediction.aggregate([
    {
      $match: {
        ...eventFilter,
        type: 'market',
        $or: [{ marketChannel: 'amm' }, { marketChannel: { $exists: false } }],
        outcome: { $not: { $regex: '\\|' } },
      },
    },
    {
      $group: {
        _id: '$outcome',
        netBuy: { $sum: { $ifNull: ['$totalInvested', { $ifNull: ['$amount', 0] }] } },
      },
    },
  ]);
  const byOptionKey = {};
  for (const r of rows) {
    const k = String(r._id || '').trim();
    if (!k || k.includes('|')) continue;
    byOptionKey[k] = ROUND(Math.max(0, Number(r.netBuy) || 0));
  }
  return byOptionKey;
}

async function getEventClaimStats(kind, eventId) {
  const Model = kind === 'match' ? Match : Poll;
  const event = await Model.findById(eventId).lean();
  if (!event) {
    const err = new Error('Event not found');
    err.statusCode = 404;
    throw err;
  }

  const eventFilter = kind === 'match' ? { match: event._id } : { poll: event._id };
  const optionKeys = getOptionKeysForEvent(event, kind);

  const [freeRows, boostRows, marketRows, orderbookByOption, ammByOption] = await Promise.all([
    Prediction.find({ ...eventFilter, type: 'free', status: 'won', jackpotPayout: { $gt: 0 } })
      .select('jackpotPayout jackpotClaimed')
      .lean(),
    Prediction.find({ ...eventFilter, type: 'boost', status: 'settled', payout: { $gt: 0 } })
      .select('payout claimed')
      .lean(),
    Prediction.find({ ...eventFilter, type: 'market', status: 'settled', payout: { $gt: 0 } })
      .select('payout claimed')
      .lean(),
    aggregateNetUserBuyFromFills({
      kind,
      eventId: event._id,
      chainMarketId: event.marketId,
    }),
    aggregateAmmNetBuy({ eventFilter }),
  ]);

  const free = sumClaimBucket(freeRows, { amountField: 'jackpotPayout', claimedField: 'jackpotClaimed' });
  const boost = sumClaimBucket(boostRows, { amountField: 'payout', claimedField: 'claimed' });
  const market = sumClaimBucket(marketRows, { amountField: 'payout', claimedField: 'claimed' });

  const marketVolumeByOption = optionKeys.map((key) => {
    const orderbookNet = Number(orderbookByOption[key]) || 0;
    const ammNet = Number(ammByOption[key]) || 0;
    const netBuy = ROUND(orderbookNet + ammNet);
    return {
      optionKey: key,
      label: optionLabel(key, event, kind),
      orderbookNetBuy: ROUND(orderbookNet),
      ammNetBuy: ROUND(ammNet),
      netBuy,
    };
  });

  const marketVolumeTotal = ROUND(marketVolumeByOption.reduce((s, o) => s + o.netBuy, 0));

  const claimsGrandTotal = ROUND(free.total + boost.total + market.total);
  const claimsGrandClaimed = ROUND(free.claimed + boost.claimed + market.claimed);
  const claimsGrandUnclaimed = ROUND(free.unclaimed + boost.unclaimed + market.unclaimed);

  const label =
    kind === 'match'
      ? `${event.teamA || 'Team A'} vs ${event.teamB || 'Team B'}`
      : String(event.question || 'Poll');

  return {
    event: {
      id: String(event._id),
      kind,
      label,
      marketId: event.marketId ?? null,
      isResolved: !!event.isResolved,
      status: event.status || null,
      result: event.result || null,
    },
    pools: {
      freeJackpotPool: ROUND(event.freeJackpotPool),
      boostPool: ROUND(event.boostPool),
      platformFees: ROUND(event.platformFees),
      marketPlatformFees: ROUND(event.marketPlatformFees),
    },
    claims: {
      free,
      boost,
      market,
      grandTotal: {
        total: claimsGrandTotal,
        claimed: claimsGrandClaimed,
        unclaimed: claimsGrandUnclaimed,
      },
    },
    marketVolume: {
      totalNetBuy: marketVolumeTotal,
      feesExcluded: true,
      note: 'Net user buy volume (buys minus sells, market-maker excluded, fees excluded).',
      byOption: marketVolumeByOption,
    },
  };
}

module.exports = { getEventClaimStats };
