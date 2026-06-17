const Order = require('../models/Order');
const OrderbookPosition = require('../models/OrderbookPosition');
const SettlementOutbox = require('../models/SettlementOutbox');
const { withOrderbookContractOrLegacy } = require('../utils/orderbookContractScope');
const {
  resolveOrderbookUserScope,
  withOrderbookContractOrLegacyForUser,
} = require('../utils/orderbookUserScope');
const { getBook, positionKey } = require('./orderbookService');

const ACTIVE_STATUSES = ['open', 'partially_filled', 'pending'];

function normStatus(o) {
  return String(o?.status || '')
    .toLowerCase()
    .trim();
}

function bestPricesFromBook(book) {
  const bestBid = book?.bids?.[0]?.limitPrice != null ? Number(book.bids[0].limitPrice) : null;
  const bestAsk = book?.asks?.[0]?.limitPrice != null ? Number(book.asks[0].limitPrice) : null;
  return { bestBid, bestAsk };
}

function isRestingLiquidityOrder(order, bookPrices) {
  const rem = Number(order.sizeRemaining) || 0;
  if (rem <= 1e-9) return false;
  const lp = Number(order.limitPrice);
  if (!Number.isFinite(lp)) return false;
  const { bestBid, bestAsk } = bookPrices;

  if (order.direction === 'buy') {
    if (bestAsk == null) return true;
    return lp < bestAsk - 1e-9;
  }
  if (order.direction === 'sell') {
    if (bestBid == null) return true;
    return lp > bestBid + 1e-9;
  }
  return false;
}

/** Limit crosses the spread ΓÇö unfilled size belongs in pending settlement, not passive book. */
function isCrossingOrder(order, bookPrices) {
  const rem = Number(order.sizeRemaining) || 0;
  if (rem <= 1e-9) return false;
  const lp = Number(order.limitPrice);
  if (!Number.isFinite(lp)) return false;
  const { bestBid, bestAsk } = bookPrices;
  if (order.direction === 'buy' && bestAsk != null) return lp >= bestAsk - 1e-9;
  if (order.direction === 'sell' && bestBid != null) return lp <= bestBid + 1e-9;
  return false;
}

/** Position rows from the ledger only (do not resurrect closed positions from old filled orders). */
function buildPositionRows(positions) {
  const rows = [];
  for (const p of positions) {
    const pk = String(p.positionKey || '');
    const [optionKey, side] = pk.split('|');
    const shares = Number(p.shares) || 0;
    const totalInvested = Number(p.totalInvested) || 0;
    if (!(shares > 1e-9) && !(totalInvested > 1e-9)) continue;
    rows.push({
      positionKey: pk,
      optionKey: optionKey || p.optionKey,
      side: side || p.side,
      shares,
      totalInvested,
      pendingShares: 0,
      updatedAt: p.updatedAt,
    });
  }
  return rows;
}

async function getUserTradingPanel(userId, chainMarketId) {
  const mid = Number(chainMarketId);
  if (!Number.isFinite(mid)) {
    throw Object.assign(new Error('Invalid chainMarketId'), { statusCode: 400 });
  }

  const scope = await resolveOrderbookUserScope(userId);

  const [orders, positions, outboxJobs] = await Promise.all([
    Order.find(
      withOrderbookContractOrLegacyForUser(scope, {
        chainMarketId: mid,
        status: { $nin: ['rejected'] },
      })
    )
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean(),
    OrderbookPosition.find(
      withOrderbookContractOrLegacyForUser(scope, {
        chainMarketId: mid,
      })
    )
      .sort({ updatedAt: -1 })
      .lean(),
    SettlementOutbox.find(
      withOrderbookContractOrLegacy({
        chainMarketId: mid,
        status: { $in: ['pending', 'processing'] },
      })
    )
      .select('orderIds status')
      .lean(),
  ]);

  const userOrderIdSet = new Set(orders.map((o) => String(o._id)));
  const pendingSettlementOrderIds = new Set();
  for (const job of outboxJobs) {
    for (const id of job.orderIds || []) {
      const sid = String(id);
      if (userOrderIdSet.has(sid)) pendingSettlementOrderIds.add(sid);
    }
  }

  const positionByKey = new Map();
  for (const p of positions) {
    positionByKey.set(String(p.positionKey || ''), p);
  }

  const bookCache = new Map();
  const uniqueBookKeys = new Set();
  for (const o of orders) {
    uniqueBookKeys.add(`${o.optionKey}|${o.side}`);
  }
  await Promise.all(
    [...uniqueBookKeys].map(async (key) => {
      const [optionKey, side] = key.split('|');
      try {
        const book = await getBook(mid, optionKey, side);
        bookCache.set(key, bestPricesFromBook(book));
      } catch {
        bookCache.set(key, { bestBid: null, bestAsk: null });
      }
    })
  );

  const workingOrders = [];
  const settlingOrders = [];
  const restingLiquidityOrders = [];

  for (const o of orders) {
    const st = normStatus(o);
    const filled = Number(o.sizeFilled) || 0;
    const remaining = Number(o.sizeRemaining) || 0;
    const pk = positionKey(o.optionKey, o.side);
    const pos = positionByKey.get(pk);
    const posShares = Number(pos?.shares) || 0;
    const bookPrices = bookCache.get(`${o.optionKey}|${o.side}`) || { bestBid: null, bestAsk: null };

    const settlementPending = pendingSettlementOrderIds.has(String(o._id));
    const fillNotInPositionYet =
      filled > 1e-9 && o.direction === 'buy' && posShares + 1e-6 < filled;
    const crossingUnfilled = remaining > 1e-9 && isCrossingOrder(o, bookPrices);
    const fullyFilled = remaining <= 1e-9 && filled > 1e-9;
    const buyFillInPositions =
      o.direction === 'buy' && filled > 1e-9 && posShares + 1e-6 >= filled;

    // Filled rows belong in Positions only; skip stale "recently filled" display.
    const isSettling =
      !fullyFilled &&
      !buyFillInPositions &&
      (crossingUnfilled ||
        (remaining > 1e-9 && (st === 'partially_filled' || st === 'pending')) ||
        (filled > 1e-9 && (settlementPending || fillNotInPositionYet)) ||
        (String(o.orderKind || '').toLowerCase() === 'market' && remaining > 1e-9 && ACTIVE_STATUSES.includes(st)));

    if (isSettling) {
      settlingOrders.push({
        ...o,
        settlementPending,
        fillNotInPositionYet: fillNotInPositionYet || settlementPending,
        crossingUnfilled,
      });
    }

    if (ACTIVE_STATUSES.includes(st) && remaining > 1e-9 && !crossingUnfilled) {
      const enriched = {
        ...o,
        settlementPending,
        bestBid: bookPrices.bestBid,
        bestAsk: bookPrices.bestAsk,
      };
      workingOrders.push(enriched);
      if (isRestingLiquidityOrder(o, bookPrices)) {
        restingLiquidityOrders.push(enriched);
      }
    }
  }

  const positionRows = buildPositionRows(positions);

  return {
    userId: String(scope.userId),
    chainMarketId: mid,
    positions: positionRows,
    workingOrders,
    settlingOrders,
    restingLiquidityOrders,
    recentFilledOrders: orders
      .filter((o) => normStatus(o) === 'filled' && (Number(o.sizeFilled) || 0) > 1e-9)
      .slice(0, 20),
  };
}

module.exports = { getUserTradingPanel, isRestingLiquidityOrder, isCrossingOrder };
