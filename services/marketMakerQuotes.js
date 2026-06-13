const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Order = require('../models/Order');
const OrderbookPosition = require('../models/OrderbookPosition');
const Settings = require('../models/Settings');
const { withOrderbookContract, withOrderbookContractOrLegacy } = require('../utils/orderbookContractScope');
const {
  placeOrder,
  loadItem,
  assertTradable,
  getBook,
  computeBuyReservedUsd,
  getFees,
  orderSideBookKey,
  sellBookCacheForKeys,
  isOptionSidePaused,
} = require('./orderbookService');
const { isCrossingOrder } = require('./orderbookTradingPanel');

function isInsufficientSharesError(e) {
  return (
    e?.code === 'INSUFFICIENT_SHARES' ||
    (e?.message && String(e.message).includes('Insufficient shares'))
  );
}

const LEVELS = 3;
const PRICE_TOL = 1e-4;

/**
 * Schedule non-blocking orderbook MM seed after admin creates a market.
 */
function scheduleMarketMakerSeed({ kind, id }) {
  setImmediate(async () => {
    try {
      const doc = kind === 'match' ? await Match.findById(id) : await Poll.findById(id);
      if (!doc) return;
      const r = await ensureQuotesForDoc(doc, kind);
      console.log('[marketMakerQuotes] seed', kind, String(id), r);
    } catch (e) {
      console.error('[marketMakerQuotes] seed failed', kind, String(id), e.message || e);
    }
  });
}

async function getMarketMakerActor() {
  // Prefer Settings (admin-configurable) so ops can rotate wallets without redeploying.
  const sWallet = await Settings.findOne({ key: 'marketMakerWalletAddress' }).lean();
  const walletLower = sWallet?.value ? String(sWallet.value).trim().toLowerCase() : '';
  if (walletLower) {
    const link = await WalletLink.findOne({ walletAddress: walletLower }).lean();
    if (link?.user) {
      const user = await User.findById(link.user);
      if (user && link.walletAddress) return { user, walletAddress: link.walletAddress };
    }
  }

  // Fallback: env MARKET_MAKER_USER_ID
  const mmUserId = process.env.MARKET_MAKER_USER_ID;
  if (!mmUserId) return null;
  const user = await User.findById(mmUserId);
  const link = await WalletLink.findOne({ user: user?._id }).lean();
  if (!user || !link?.walletAddress) return null;
  return { user, walletAddress: link.walletAddress };
}

function matchOptionKeys(doc) {
  const keys = ['TeamA', 'TeamB'];
  if (doc?.drawEnabled !== false) keys.splice(1, 0, 'Draw');
  return keys;
}

function midForOutcome(doc, optionKey, side) {
  const list = doc?.startingPrices || doc?.orderbook?.startingPrices || [];
  const row = list.find((r) => String(r.optionKey) === String(optionKey));
  if (!row) return 0.5;
  const yes = Number(row.yesPrice);
  const no = Number(row.noPrice);
  if (side === 'YES' && Number.isFinite(yes) && yes > 0 && yes < 1) return yes;
  if (side === 'NO' && Number.isFinite(no) && no > 0 && no < 1) return no;
  return 0.5;
}

function pollOptionKeys(item) {
  const keys = (item.options || []).map((o) => String(o.text || '').trim()).filter(Boolean);
  if (keys.length > 0) return keys;
  // Schema default is optionType 'options'; admin legacy path still uses YES/NO liquidity with no option rows.
  if (String(item.optionType || '') === 'normal') return ['YES', 'NO'];
  const y = Number(item.marketYesLiquidity) || 0;
  const n = Number(item.marketNoLiquidity) || 0;
  if (y > 0 || n > 0) return ['YES', 'NO'];
  if (item.marketId != null) return ['YES', 'NO'];
  return [];
}

function buildLevelPrices(ob, mid = 0.5) {
  const spread = (ob.spreadBps ?? 80) / 10000;
  const tick = Math.max(0.005, spread / Math.max(2, LEVELS));
  const bids = [];
  const asks = [];
  for (let i = 0; i < LEVELS; i++) {
    bids.push(Math.max(0.01, mid - spread / 2 - i * tick));
    asks.push(Math.min(0.99, mid + spread / 2 + i * tick));
  }
  return { bids, asks };
}

async function mmExposureBySideUsdc({ chainMarketId, mmWalletLower, side }) {
  // Approximate "exposure" as (filled invested on that side) + (reserved collateral on open MM buys)
  const fees = await getFees();
  const [posAgg, mmOrders] = await Promise.all([
    OrderbookPosition.aggregate([
      {
        $match: withOrderbookContractOrLegacy({
          chainMarketId,
          walletAddress: mmWalletLower,
          positionKey: new RegExp(`\\|${side}$`),
        }),
      },
      { $group: { _id: null, invested: { $sum: '$totalInvested' } } },
    ]),
    Order.find(
      withOrderbookContractOrLegacy({
        chainMarketId,
        walletAddress: mmWalletLower,
        isMarketMaker: true,
        direction: 'buy',
        side,
        status: { $in: ['open', 'partially_filled'] },
        sizeRemaining: { $gt: 1e-9 },
      })
    )
      .select('chainMarketId optionKey side walletAddress sizeRemaining limitPrice orderKind direction')
      .lean(),
  ]);
  const invested = posAgg?.[0]?.invested || 0;
  const keySet = new Set();
  for (const o of mmOrders) {
    if (o.orderKind === 'limit') keySet.add(orderSideBookKey(o.chainMarketId, o.optionKey, o.side));
  }
  const bookCache = await sellBookCacheForKeys(keySet);
  let reserved = 0;
  for (const o of mmOrders) {
    const book = o.orderKind === 'limit' ? bookCache.get(orderSideBookKey(o.chainMarketId, o.optionKey, o.side)) : null;
    reserved += await computeBuyReservedUsd(o, fees, book);
  }
  reserved = parseFloat(reserved.toFixed(6));
  return Math.max(0, (invested || 0) + (reserved || 0));
}

async function hasOpenMmQuoteAt({
  chainMarketId,
  optionKey,
  side,
  direction,
  limitPrice,
  mmWalletLower,
}) {
  const lo = limitPrice - PRICE_TOL;
  const hi = limitPrice + PRICE_TOL;
  const one = await Order.findOne(
    withOrderbookContractOrLegacy({
      chainMarketId,
      optionKey,
      side,
      direction,
      isMarketMaker: true,
      walletAddress: mmWalletLower,
      status: { $in: ['open', 'partially_filled'] },
      sizeRemaining: { $gt: 1e-9 },
      limitPrice: { $gte: lo, $lte: hi },
    })
  )
    .select('_id')
    .lean();
  return !!one;
}

function normOrderStatus(o) {
  return String(o?.status || '')
    .toLowerCase()
    .trim();
}

/**
 * MM takes the other side of user crossing limits and partially-filled remainders (clears settling queue).
 */
async function absorbUserCrossingAndPartialOrders({
  doc,
  kind,
  actor,
  ob,
  riskPausedYes,
  riskPausedNo,
  matchId,
  pollId,
}) {
  if (!actor?.walletAddress || !doc?.marketId) return { absorbed: 0 };

  const chainMarketId = doc.marketId;
  const mmWalletLower = String(actor.walletAddress).trim().toLowerCase();
  const optionKeys = kind === 'match' ? matchOptionKeys(doc) : pollOptionKeys(doc);
  if (!optionKeys.length) return { absorbed: 0 };

  const userOrders = await Order.find(
    withOrderbookContractOrLegacy({
      chainMarketId,
      isMarketMaker: { $ne: true },
      status: { $in: ['open', 'partially_filled', 'pending'] },
      sizeRemaining: { $gt: 1e-9 },
    })
  )
    .sort({ updatedAt: 1 })
    .limit(80)
    .lean();

  if (!userOrders.length) return { absorbed: 0 };

  const bookCache = new Map();
  const bookPricesFor = async (optionKey, side) => {
    const k = `${optionKey}|${side}`;
    if (bookCache.has(k)) return bookCache.get(k);
    try {
      const book = await getBook(chainMarketId, optionKey, side);
      const prices = {
        bestBid: book.bids[0]?.limitPrice != null ? Number(book.bids[0].limitPrice) : null,
        bestAsk: book.asks[0]?.limitPrice != null ? Number(book.asks[0].limitPrice) : null,
      };
      bookCache.set(k, prices);
      return prices;
    } catch {
      const empty = { bestBid: null, bestAsk: null };
      bookCache.set(k, empty);
      return empty;
    }
  };

  const qBase = ob.quoteSizeUsdc ?? 50;
  const maxTake = Math.max(5, Math.round(qBase * 100) / 100);
  let absorbed = 0;

  const basePayload = {
    userId: actor.user._id,
    walletAddress: actor.walletAddress,
    matchId,
    pollId,
  };

  for (const o of userOrders) {
    const st = normOrderStatus(o);
    const remaining = Number(o.sizeRemaining) || 0;
    if (remaining <= 1e-9) continue;

    const side = o.side;
    if ((ob.marketPaused || ob.riskPausedMarket) && o.direction === 'buy') continue;
    if (isOptionSidePaused(ob, o.optionKey, side) && o.direction === 'buy') continue;

    const bookPrices = await bookPricesFor(o.optionKey, side);
    const crossing = isCrossingOrder(o, bookPrices);
    const partial = st === 'partially_filled';
    if (!crossing && !partial) continue;

    const mmDirection = o.direction === 'buy' ? 'sell' : 'buy';
    const takeSize = Math.min(remaining, maxTake);
    if (takeSize <= 1e-9) continue;

    try {
      await placeOrder({
        ...basePayload,
        optionKey: o.optionKey,
        side: o.side,
        direction: mmDirection,
        orderKind: 'market',
        size: takeSize,
        slippageBps: 200,
        isMarketMaker: true,
      });
      absorbed += 1;
    } catch (e) {
      if (e?.code === 'INSUFFICIENT_VAULT' || isInsufficientSharesError(e)) {
        console.warn(
          '[marketMakerQuotes] absorb skip (balance)',
          chainMarketId,
          o.optionKey,
          o.side,
          e.message
        );
        continue;
      }
      console.warn('[marketMakerQuotes] absorb', chainMarketId, o._id, e.message || e);
    }
  }

  return { absorbed };
}

/**
 * Ensure visible book has at least LEVELS bids and LEVELS asks (any maker), topping up MM limits.
 */
async function ensureMinBookDepth({
  doc,
  ob,
  chainMarketId,
  optionKey,
  side,
  mmWalletLower,
  pauseNewBuys,
  placeMmOrder,
  basePayload,
  spreadMult,
  quoteMult,
}) {
  const book = await getBook(chainMarketId, optionKey, side);
  const bidCount = book.bids?.length || 0;
  const askCount = book.asks?.length || 0;
  const needBids = bidCount < LEVELS;
  const needAsks = !pauseNewBuys && askCount < LEVELS;
  if (!needBids && !needAsks) return 0;

  const spreadBps = (ob.spreadBps ?? 80) * spreadMult;
  const mid = midForOutcome(doc, optionKey, side);
  const { bids, asks } = buildLevelPrices({ ...ob, spreadBps }, mid);
  const qBase = ob.quoteSizeUsdc ?? 50;
  const q = Math.max(1, Math.round(((qBase * quoteMult) / LEVELS) * 100) / 100);

  let placed = 0;

  for (let i = bidCount; i < LEVELS; i++) {
    const bidPx = bids[Math.min(i, LEVELS - 1)];
    const hasBuy = await hasOpenMmQuoteAt({
      chainMarketId,
      optionKey,
      side,
      direction: 'buy',
      limitPrice: bidPx,
      mmWalletLower,
    });
    if (!hasBuy) {
      const ok = await placeMmOrder({
        ...basePayload,
        optionKey,
        side,
        direction: 'buy',
        orderKind: 'limit',
        limitPrice: bidPx,
        size: q,
      });
      if (ok) placed += 1;
    }
  }

  for (let i = askCount; i < LEVELS && !pauseNewBuys; i++) {
    const askPx = asks[Math.min(i, LEVELS - 1)];
    const hasSell = await hasOpenMmQuoteAt({
      chainMarketId,
      optionKey,
      side,
      direction: 'sell',
      limitPrice: askPx,
      mmWalletLower,
    });
    if (!hasSell) {
      const ok = await placeMmOrder({
        ...basePayload,
        optionKey,
        side,
        direction: 'sell',
        orderKind: 'limit',
        limitPrice: askPx,
        size: q,
      });
      if (ok) placed += 1;
    }
  }

  return placed;
}

async function mmTreasuryMarkToMidLossUsdc({ chainMarketId, mmWalletLower }) {
  const positions = await OrderbookPosition.find(
    withOrderbookContract({ chainMarketId, walletAddress: mmWalletLower })
  ).lean();
  const midCache = new Map();
  async function midFor(optionKey, side) {
    const k = `${optionKey}|${side}`;
    if (midCache.has(k)) return midCache.get(k);
    const { bids, asks } = await getBook(chainMarketId, optionKey, side);
    const bb = bids[0]?.limitPrice != null ? Number(bids[0].limitPrice) : null;
    const ba = asks[0]?.limitPrice != null ? Number(asks[0].limitPrice) : null;
    let m = null;
    if (bb != null && ba != null) m = (bb + ba) / 2;
    else if (bb != null) m = bb;
    else if (ba != null) m = ba;
    else m = 0.5;
    midCache.set(k, m);
    return m;
  }
  let sum = 0;
  for (const p of positions) {
    const pk = String(p.positionKey || '');
    const idx = pk.lastIndexOf('|');
    if (idx <= 0) continue;
    const optionKey = pk.slice(0, idx);
    const side = pk.slice(idx + 1);
    if (side !== 'YES' && side !== 'NO') continue;
    const m = await midFor(optionKey, side);
    const shares = Number(p.shares) || 0;
    const inv = Number(p.totalInvested) || 0;
    sum += Math.max(0, inv - shares * m);
  }
  return sum;
}

async function cancelMmQuotesForOptionSide(chainMarketId, mmWalletLower, optionKey, side) {
  await Order.updateMany(
    withOrderbookContract({
      chainMarketId,
      walletAddress: mmWalletLower,
      isMarketMaker: true,
      optionKey,
      side,
      status: { $in: ['open', 'partially_filled', 'pending'] },
    }),
    { $set: { status: 'cancelled', reservedCollateral: 0, sizeRemaining: 0 } }
  );
}

/** Cancel all MM resting quotes for a market, then repost from current startingPrices / controls. */
async function forceRequoteMarketMm(doc, kind) {
  const actor = await getMarketMakerActor();
  if (!actor || !doc?.marketId) {
    return { skipped: true, reason: 'MM actor or marketId missing' };
  }
  const mmWalletLower = String(actor.walletAddress).toLowerCase();
  const optionKeys = kind === 'match' ? matchOptionKeys(doc) : pollOptionKeys(doc);
  for (const optionKey of optionKeys) {
    for (const side of ['YES', 'NO']) {
      await cancelMmQuotesForOptionSide(doc.marketId, mmWalletLower, optionKey, side);
    }
  }
  return ensureQuotesForDoc(doc, kind);
}

/** Non-blocking requote after admin updates target odds — keeps PUT responses fast. */
function scheduleForceRequoteMarketMm({ kind, id }) {
  setImmediate(async () => {
    try {
      const doc = kind === 'match' ? await Match.findById(id) : await Poll.findById(id);
      if (!doc) return;
      const r = await forceRequoteMarketMm(doc, kind);
      console.log('[marketMakerQuotes] forceRequote', kind, String(id), r?.skipped ? r : 'ok');
    } catch (e) {
      console.error('[marketMakerQuotes] forceRequote failed', kind, String(id), e.message || e);
    }
  });
}

async function cancelMmQuotesForChainSide(chainMarketId, mmWalletLower, side) {
  await Order.updateMany(
    withOrderbookContract({
      chainMarketId,
      walletAddress: mmWalletLower,
      isMarketMaker: true,
      side,
      status: { $in: ['open', 'partially_filled', 'pending'] },
    }),
    { $set: { status: 'cancelled', reservedCollateral: 0, sizeRemaining: 0 } }
  );
}

/**
 * Persist treasury / exposure risk halts (additive to admin pauses). Call from MM worker and before user/MM orders.
 * @returns {{ patch: object|null, yesExposure: number, noExposure: number, lossEst: number }}
 */
async function refreshOrderbookRiskState(doc, kind, actor) {
  const ob = doc.orderbook || {};
  if (!doc.marketId) {
    return { patch: null, yesExposure: 0, noExposure: 0, lossEst: 0 };
  }
  const Model = kind === 'match' ? Match : Poll;
  if (!actor?.walletAddress) {
    await Model.updateOne(
      { _id: doc._id },
      {
        $set: {
          'orderbook.riskPausedMarket': false,
          'orderbook.riskPausedYes': false,
          'orderbook.riskPausedNo': false,
        },
      }
    );
    const clear = { riskPausedMarket: false, riskPausedYes: false, riskPausedNo: false };
    doc.orderbook = { ...(doc.orderbook || {}), ...clear };
    return { patch: clear, yesExposure: 0, noExposure: 0, lossEst: 0 };
  }

  const mmWalletLower = String(actor.walletAddress).toLowerCase();
  const chainMarketId = doc.marketId;
  const [yesExposure, noExposure] = await Promise.all([
    mmExposureBySideUsdc({ chainMarketId, mmWalletLower, side: 'YES' }),
    mmExposureBySideUsdc({ chainMarketId, mmWalletLower, side: 'NO' }),
  ]);
  const lossEst = await mmTreasuryMarkToMidLossUsdc({ chainMarketId, mmWalletLower });
  const totalExposure = yesExposure + noExposure;
  const capAlloc = ob.maxMarketAllocationUsdc ?? 0;
  const capLoss = ob.maxTreasuryLossUsdc ?? 0;
  const riskPausedMarket =
    (capAlloc > 0 && totalExposure >= capAlloc) || (capLoss > 0 && lossEst >= capLoss);
  const riskPausedYes =
    (ob.maxTreasuryLossYesUsdc ?? 0) > 0 && yesExposure >= (ob.maxTreasuryLossYesUsdc ?? 0);
  const riskPausedNo =
    (ob.maxTreasuryLossNoUsdc ?? 0) > 0 && noExposure >= (ob.maxTreasuryLossNoUsdc ?? 0);

  await Model.updateOne(
    { _id: doc._id },
    {
      $set: {
        'orderbook.riskPausedMarket': !!riskPausedMarket,
        'orderbook.riskPausedYes': !!riskPausedYes,
        'orderbook.riskPausedNo': !!riskPausedNo,
      },
    }
  );
  const patch = {
    riskPausedMarket: !!riskPausedMarket,
    riskPausedYes: !!riskPausedYes,
    riskPausedNo: !!riskPausedNo,
  };
  doc.orderbook = { ...(doc.orderbook || {}), ...patch };
  return { patch, yesExposure, noExposure, lossEst };
}

async function syncOrderbookRiskToDb(item, kind) {
  const actor = await getMarketMakerActor();
  return refreshOrderbookRiskState(item, kind, actor);
}

/**
 * Top up to LEVELS bid + LEVELS ask per (outcome, YES/NO) for the MM wallet.
 * Idempotent: only places missing price levels so cron can run safely.
 *
 * Note: Admin "initial liquidity" (batchAddOrderbookLiquidity) is on-chain only;
 * the CLOB matcher uses MongoDB orders — this is what makes market orders work.
 */
async function ensureQuotesForDoc(doc, kind) {
  const actor = await getMarketMakerActor();
  if (!actor) {
    return { skipped: true, reason: 'MARKET_MAKER_USER_ID or linked wallet missing' };
  }

  const Model = kind === 'match' ? Match : Poll;
  const freshDoc = await Model.findById(doc._id);
  if (!freshDoc) {
    return { skipped: true, reason: 'market document not found' };
  }
  doc = freshDoc;

  const ob0 = doc.orderbook || {};
  if (ob0.botEnabled === false) {
    return { skipped: true, reason: 'bot disabled' };
  }
  if (!doc.marketId) {
    return { skipped: true, reason: 'no chain marketId' };
  }

  const matchId = kind === 'match' ? doc._id : undefined;
  const pollId = kind === 'poll' ? doc._id : undefined;

  try {
    const { item } = await loadItem(matchId, pollId);
    assertTradable(item);
  } catch (e) {
    return { skipped: true, reason: e.message || 'not tradable' };
  }

  const optionKeys = kind === 'match' ? matchOptionKeys(doc) : pollOptionKeys(doc);
  if (!optionKeys.length) {
    return { skipped: true, reason: 'no outcomes' };
  }

  const mmWalletLower = String(actor.walletAddress).trim().toLowerCase();
  const chainMarketId = doc.marketId;
  const placedIds = [];

  const { patch, yesExposure, noExposure } = await refreshOrderbookRiskState(doc, kind, actor);
  doc = (await Model.findById(doc._id)) || doc;
  const ob = doc.orderbook || {};
  const marketPausedForBuys = !!(patch?.riskPausedMarket || ob.riskPausedMarket || ob.marketPaused);

  const riskPausedYes = !!(ob.pauseSideYes || ob.riskPausedYes);
  const riskPausedNo = !!(ob.pauseSideNo || ob.riskPausedNo);

  const yesCap = Number(ob.widenSpreadYesCapUsdc) || 0;
  const noCap = Number(ob.widenSpreadNoCapUsdc) || 0;
  const yesWiden = yesCap > 0 && yesExposure >= yesCap;
  const noWiden = noCap > 0 && noExposure >= noCap;
  const prevLatchYes = ob.mmWidenActiveYes === true;
  const prevLatchNo = ob.mmWidenActiveNo === true;
  const widenLatchDirty = prevLatchYes !== yesWiden || prevLatchNo !== noWiden;

  // Only cancel when entering widen mode or leaving it (not every tick while widened).
  if (yesWiden !== prevLatchYes) {
    await cancelMmQuotesForChainSide(chainMarketId, mmWalletLower, 'YES');
  }
  if (noWiden !== prevLatchNo) {
    await cancelMmQuotesForChainSide(chainMarketId, mmWalletLower, 'NO');
  }

  const placeMmOrder = async (payload) => {
    try {
      const o = await placeOrder({ ...payload, isMarketMaker: true });
      placedIds.push(o._id);
      return true;
    } catch (e) {
      if (e?.code === 'INSUFFICIENT_VAULT') {
        console.warn('[marketMakerQuotes] vault', doc.marketId, payload.optionKey, payload.side, payload.direction, e.message);
        return false;
      }
      if (isInsufficientSharesError(e)) {
        console.warn('[marketMakerQuotes] shares (immediate fill)', doc.marketId, payload.optionKey, payload.side, e.message);
        return false;
      }
      throw e;
    }
  };

  const basePayload = {
    userId: actor.user._id,
    walletAddress: actor.walletAddress,
    matchId,
    pollId,
  };

  let absorbedCount = 0;
  try {
    const absorbRes = await absorbUserCrossingAndPartialOrders({
      doc,
      kind,
      actor,
      ob,
      riskPausedYes,
      riskPausedNo,
      matchId,
      pollId,
    });
    absorbedCount = absorbRes.absorbed || 0;
  } catch (e) {
    console.warn('[marketMakerQuotes] absorb batch', doc.marketId, e.message || e);
  }

  for (const optionKey of optionKeys) {
    for (const side of ['YES', 'NO']) {
      const sidePaused = isOptionSidePaused(ob, optionKey, side);
      const pauseNewBuys = marketPausedForBuys || sidePaused;

      const widen = side === 'YES' ? yesWiden : noWiden;
      const spreadMult = widen ? 2.5 : 1;
      const quoteMult = widen ? 0.4 : 1;
      const spreadBps = (ob.spreadBps ?? 80) * spreadMult;
      const mid = midForOutcome(doc, optionKey, side);
      const { bids, asks } = buildLevelPrices({ ...ob, spreadBps }, mid);
      const qBase = ob.quoteSizeUsdc ?? 50;
      const q = Math.max(1, Math.round(((qBase * quoteMult) / LEVELS) * 100) / 100);

      for (let i = 0; i < LEVELS; i++) {
        const bidPx = bids[i];
        const hasBuy = await hasOpenMmQuoteAt({
          chainMarketId,
          optionKey,
          side,
          direction: 'buy',
          limitPrice: bidPx,
          mmWalletLower,
        });
        if (!hasBuy) {
          await placeMmOrder({
            ...basePayload,
            optionKey,
            side,
            direction: 'buy',
            orderKind: 'limit',
            limitPrice: bidPx,
            size: q,
          });
        }
      }

      if (!pauseNewBuys) {
        for (let i = 0; i < LEVELS; i++) {
          const askPx = asks[i];
          const hasSell = await hasOpenMmQuoteAt({
            chainMarketId,
            optionKey,
            side,
            direction: 'sell',
            limitPrice: askPx,
            mmWalletLower,
          });
          if (!hasSell) {
            await placeMmOrder({
              ...basePayload,
              optionKey,
              side,
              direction: 'sell',
              orderKind: 'limit',
              limitPrice: askPx,
              size: q,
            });
          }
        }
      }

      const depthPlaced = await ensureMinBookDepth({
        doc,
        ob,
        chainMarketId,
        optionKey,
        side,
        mmWalletLower,
        pauseNewBuys,
        placeMmOrder,
        basePayload,
        spreadMult,
        quoteMult,
      });
      if (depthPlaced > 0) {
        for (let n = 0; n < depthPlaced; n++) placedIds.push('depth');
      }
    }
  }

  ob.mmWidenActiveYes = yesWiden;
  ob.mmWidenActiveNo = noWiden;

  if (placedIds.length || widenLatchDirty || absorbedCount > 0) {
    ob.botLastTickAt = new Date();
    doc.orderbook = ob;
    await doc.save();
    return {
      ok: true,
      placedNewCount: placedIds.length,
      absorbedCount,
      placed: placedIds,
      updatedWidenLatch: widenLatchDirty,
    };
  }

  return { skipped: true, reason: 'order book already has MM quotes at target levels' };
}

/** @deprecated name — same as ensureQuotesForDoc */
async function seedOrderbookForDoc(doc, kind) {
  return ensureQuotesForDoc(doc, kind);
}

async function runMatchMmTick(matchId) {
  const m = await Match.findById(matchId);
  if (!m) {
    const e = new Error('Match not found');
    e.statusCode = 404;
    throw e;
  }
  if (!m.marketId) {
    const e = new Error('Match has no chain marketId');
    e.statusCode = 400;
    throw e;
  }
  const ob = m.orderbook || {};
  if (ob.botEnabled === false) {
    return { skipped: true, reason: 'bot disabled' };
  }
  return ensureQuotesForDoc(m, 'match');
}

async function runPollMmTick(pollId) {
  const p = await Poll.findById(pollId);
  if (!p) {
    const e = new Error('Poll not found');
    e.statusCode = 404;
    throw e;
  }
  if (!p.marketId) {
    const e = new Error('Poll has no chain marketId');
    e.statusCode = 400;
    throw e;
  }
  const ob = p.orderbook || {};
  if (ob.botEnabled === false) {
    return { skipped: true, reason: 'bot disabled' };
  }
  return ensureQuotesForDoc(p, 'poll');
}

/**
 * Periodic maintenance: refill thin books on all active markets (idempotent).
 */
async function ensureAllActiveMarketsQuotes() {
  const actor = await getMarketMakerActor();
  if (!actor) {
    return { skipped: true, reason: 'MARKET_MAKER_USER_ID or linked wallet missing' };
  }

  const max = Math.min(200, Math.max(10, parseInt(process.env.MM_MAINTENANCE_MAX_MARKETS || '120', 10)));

  const matchFilter = {
    marketId: { $exists: true, $ne: null },
    isResolved: { $ne: true },
    status: { $nin: ['locked', 'completed'] },
    $or: [{ 'orderbook.botEnabled': true }, { 'orderbook.botEnabled': { $exists: false } }],
  };

  const pollFilter = {
    marketId: { $exists: true, $ne: null },
    isResolved: { $ne: true },
    status: { $nin: ['locked', 'settled'] },
    $or: [{ 'orderbook.botEnabled': true }, { 'orderbook.botEnabled': { $exists: false } }],
  };

  const matches = await Match.find(matchFilter).limit(max).exec();
  const polls = await Poll.find(pollFilter).limit(max).exec();

  let marketsTouched = 0;
  let ordersPlaced = 0;
  let ordersAbsorbed = 0;

  for (const m of matches) {
    try {
      const r = await ensureQuotesForDoc(m, 'match');
      if (r.ok && (r.placedNewCount || r.absorbedCount)) {
        marketsTouched += 1;
        ordersPlaced += r.placedNewCount || 0;
        ordersAbsorbed += r.absorbedCount || 0;
      }
    } catch (e) {
      console.error('[marketMakerQuotes] match', String(m._id), e.message || e);
    }
  }

  for (const p of polls) {
    try {
      const r = await ensureQuotesForDoc(p, 'poll');
      if (r.ok && (r.placedNewCount || r.absorbedCount)) {
        marketsTouched += 1;
        ordersPlaced += r.placedNewCount || 0;
        ordersAbsorbed += r.absorbedCount || 0;
      }
    } catch (e) {
      console.error('[marketMakerQuotes] poll', String(p._id), e.message || e);
    }
  }

  return {
    marketsTouched,
    ordersPlaced,
    ordersAbsorbed,
    matchesScanned: matches.length,
    pollsScanned: polls.length,
  };
}

module.exports = {
  scheduleMarketMakerSeed,
  seedOrderbookForDoc,
  ensureQuotesForDoc,
  ensureAllActiveMarketsQuotes,
  runMatchMmTick,
  runPollMmTick,
  getMarketMakerActor,
  syncOrderbookRiskToDb,
  refreshOrderbookRiskState,
  forceRequoteMarketMm,
  scheduleForceRequoteMarketMm,
  LEVELS,
};
