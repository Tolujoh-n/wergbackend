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
  midFromBookSide,
  depthWeightedMidFromBookSide,
} = require('./orderbookService');
const { isCrossingOrder } = require('./orderbookTradingPanel');
const { mmLevelSizesForSide, mmLevelCountForSide, sideVolumeUsdc } = require('../utils/mmQuoteVolume');
const OrderbookFill = require('../models/OrderbookFill');

function isInsufficientSharesError(e) {
  return (
    e?.code === 'INSUFFICIENT_SHARES' ||
    (e?.message && String(e.message).includes('Insufficient shares'))
  );
}

const LEVELS = 3; // legacy default; dynamic levels use mmLevelCountForSide
const PRICE_TOL = 1e-4;
/** Requote when MM center drifts this far from live fair mid (absolute price). */
const MID_DRIFT_ABS = 0.02;

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

/** Admin target / seed mid from startingPrices (YES/NO per outcome). */
function targetMidForOutcome(doc, optionKey, side) {
  const list = doc?.startingPrices || doc?.orderbook?.startingPrices || [];
  const row = list.find((r) => String(r.optionKey) === String(optionKey));
  if (!row) return 0.5;
  const yes = Number(row.yesPrice);
  const no = Number(row.noPrice);
  if (side === 'YES' && Number.isFinite(yes) && yes > 0 && yes < 1) return yes;
  if (side === 'NO' && Number.isFinite(no) && no > 0 && no < 1) return no;
  return 0.5;
}

/** @deprecated alias — prefer targetMidForOutcome or resolveQuoteMid */
function midForOutcome(doc, optionKey, side) {
  return targetMidForOutcome(doc, optionKey, side);
}

/**
 * Size of external (non-MM) depth used for mid — top `depth` levels.
 */
function externalDepthSize(rows, depth = 3) {
  const n = Math.max(1, Math.min(10, Number(depth) || 3));
  let sizeSum = 0;
  for (const r of (rows || []).slice(0, n)) {
    const sz = Number(r.sizeRemaining) || 0;
    if (sz > 1e-9) sizeSum += sz;
  }
  return sizeSum;
}

/**
 * Fair mid for MM quotes after the market is live (Polymarket-style):
 * depth-weighted top-3 mid from non-MM orders, blended with complement of
 * the other side. Never anchors on the MM's own quotes (self-reinforcing drift).
 *
 * PreferTarget (admin force-requote) posts at startingPrices to pull odds.
 */
async function resolveQuoteMid({ doc, optionKey, side, chainMarketId, mmWalletLower, preferTarget = false }) {
  const target = targetMidForOutcome(doc, optionKey, side);
  if (preferTarget) return target;

  let book;
  let otherBook = { bids: [], asks: [] };
  try {
    book = await getBook(chainMarketId, optionKey, side);
    const otherSide = side === 'YES' ? 'NO' : 'YES';
    otherBook = await getBook(chainMarketId, optionKey, otherSide);
  } catch {
    book = { bids: [], asks: [] };
  }

  const wl = String(mmWalletLower || '').toLowerCase();
  const isMm = (r) => String(r?.walletAddress || '').toLowerCase() === wl;
  const extBids = (book.bids || []).filter((r) => !isMm(r));
  const extAsks = (book.asks || []).filter((r) => !isMm(r));
  const extOtherBids = (otherBook.bids || []).filter((r) => !isMm(r));
  const extOtherAsks = (otherBook.asks || []).filter((r) => !isMm(r));

  const thisDepth = externalDepthSize(extBids) + externalDepthSize(extAsks);
  const otherDepth = externalDepthSize(extOtherBids) + externalDepthSize(extOtherAsks);
  const thisMid = depthWeightedMidFromBookSide(extBids, extAsks, 3);
  const otherMid = depthWeightedMidFromBookSide(extOtherBids, extOtherAsks, 3);

  let fair = null;
  if (thisMid != null && otherMid != null) {
    // Complement blend (YES ≈ 1 − NO) reduces one-sided spoof/thin-book skew.
    fair = 0.5 * thisMid + 0.5 * (1 - otherMid);
  } else if (thisMid != null) {
    fair = thisMid;
  } else if (otherMid != null) {
    fair = 1 - otherMid;
  }

  // Thin or empty external book: do not chase tape / own quotes — stay near admin target.
  const MIN_EXT_DEPTH = 5; // shares
  const thin = thisDepth + otherDepth < MIN_EXT_DEPTH;

  if (fair == null || thin) {
    let lastPx = null;
    try {
      const lastFill = await OrderbookFill.findOne(
        withOrderbookContract({
          chainMarketId,
          optionKey: String(optionKey),
          side,
        })
      )
        .sort({ filledAt: -1 })
        .select('price filledAt')
        .lean();
      const px = Number(lastFill?.price);
      if (Number.isFinite(px) && px > 0 && px < 1) lastPx = px;
    } catch {
      /* ignore tape errors */
    }
    if (fair == null && lastPx != null) {
      // Tape alone is noisy; never use it without pulling hard to target.
      fair = 0.25 * lastPx + 0.75 * target;
    } else if (fair == null) {
      fair = target;
    } else if (thin) {
      // Sparse external interest: mostly target so odds stay Polymarket-coherent.
      fair = 0.35 * fair + 0.65 * target;
    }
  } else if (Number.isFinite(target)) {
    // Healthy external depth: mostly follow the market, soft pull to target.
    fair = 0.85 * fair + 0.15 * target;
  }

  if (fair != null && Number.isFinite(fair)) {
    return Math.max(0.01, Math.min(0.99, fair));
  }
  return target;
}

/**
 * Polymarket-style coherent mids: outcome YES probs sum ≈ 1, and NO = 1 − YES per outcome.
 */
async function resolveCoherentMids({
  doc,
  optionKeys,
  chainMarketId,
  mmWalletLower,
  preferTarget = false,
}) {
  const yesRaw = {};
  for (const optionKey of optionKeys) {
    yesRaw[optionKey] = await resolveQuoteMid({
      doc,
      optionKey,
      side: 'YES',
      chainMarketId,
      mmWalletLower,
      preferTarget,
    });
  }
  const sum = Object.values(yesRaw).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const optionKey of optionKeys) {
    const yes = Math.max(0.01, Math.min(0.99, yesRaw[optionKey] / sum));
    out[optionKey] = {
      YES: yes,
      NO: Math.max(0.01, Math.min(0.99, 1 - yes)),
    };
  }
  return out;
}

/** Center of this MM wallet's resting quotes (for drift detection). */
async function mmOwnQuoteCenter({ chainMarketId, optionKey, side, mmWalletLower }) {
  const orders = await Order.find(
    withOrderbookContractOrLegacy({
      chainMarketId,
      optionKey,
      side,
      isMarketMaker: true,
      walletAddress: mmWalletLower,
      status: { $in: ['open', 'partially_filled'] },
      sizeRemaining: { $gt: 1e-9 },
    })
  )
    .select('direction limitPrice')
    .lean();
  if (!orders.length) return null;
  let bestBid = null;
  let bestAsk = null;
  for (const o of orders) {
    const px = Number(o.limitPrice);
    if (!Number.isFinite(px)) continue;
    if (o.direction === 'buy') bestBid = bestBid == null ? px : Math.max(bestBid, px);
    else if (o.direction === 'sell') bestAsk = bestAsk == null ? px : Math.min(bestAsk, px);
  }
  if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
  if (bestBid != null) return bestBid;
  if (bestAsk != null) return bestAsk;
  return null;
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

function buildLevelPrices(ob, mid = 0.5, levelCount = LEVELS) {
  const levels = Math.max(1, Math.min(12, Number(levelCount) || LEVELS));
  const rawSpread = (ob.spreadBps ?? 80) / 10000;
  const floor = (ob.minSpreadFloorBps ?? 0) / 10000;
  const spread = Math.max(rawSpread, floor, 0.01);
  const tick = Math.max(0.005, spread / Math.max(2, levels));
  const bids = [];
  const asks = [];
  for (let i = 0; i < levels; i++) {
    bids.push(Math.max(0.01, mid - spread / 2 - i * tick));
    asks.push(Math.min(0.99, mid + spread / 2 + i * tick));
  }
  return { bids, asks, tick, spread };
}

/**
 * Keep maintenance quotes from crossing the external book (avoids unintended taker fills).
 * Admin target pulls (preferTarget) skip clamping so the bot can move the market.
 */
function clampPassiveLevels(bids, asks, book, mmWalletLower, tick, allowCross) {
  if (allowCross) return { bids, asks };
  const wl = String(mmWalletLower || '').toLowerCase();
  const isMm = (r) => String(r?.walletAddress || '').toLowerCase() === wl;
  const significant = (r) => {
    const px = Number(r?.limitPrice);
    const sz = Number(r?.sizeRemaining) || 0;
    return Number.isFinite(px) && sz > 1e-9 && px * sz >= 0.5;
  };
  const extBids = (book?.bids || []).filter((r) => !isMm(r) && significant(r));
  const extAsks = (book?.asks || []).filter((r) => !isMm(r) && significant(r));
  const bestExtBid = extBids[0]?.limitPrice != null ? Number(extBids[0].limitPrice) : null;
  const bestExtAsk = extAsks[0]?.limitPrice != null ? Number(extAsks[0].limitPrice) : null;
  const t = Math.max(0.005, Number(tick) || 0.005);

  const outBids = bids.map((px) => {
    let p = px;
    if (bestExtAsk != null && Number.isFinite(bestExtAsk)) {
      p = Math.min(p, bestExtAsk - t);
    }
    return Math.max(0.01, Math.min(0.99, p));
  });
  const outAsks = asks.map((px) => {
    let p = px;
    if (bestExtBid != null && Number.isFinite(bestExtBid)) {
      p = Math.max(p, bestExtBid + t);
    }
    return Math.max(0.01, Math.min(0.99, p));
  });
  return { bids: outBids, asks: outAsks };
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
    .sort({ sizeRemaining: -1, updatedAt: 1 })
    .limit(120)
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
    const isMarket = String(o.orderKind || '').toLowerCase() === 'market';
    if (!crossing && !partial && !isMarket) continue;

    const mmDirection = o.direction === 'buy' ? 'sell' : 'buy';
    let takeRemaining = remaining;

    for (let pass = 0; pass < 5 && takeRemaining > 1e-9; pass += 1) {
      try {
        await placeOrder({
          ...basePayload,
          optionKey: o.optionKey,
          side: o.side,
          direction: mmDirection,
          orderKind: 'market',
          size: takeRemaining,
          slippageBps: Math.max(200, Number(ob.maxSlippageBps) || 1000),
          isMarketMaker: true,
        });
        absorbed += 1;
        const fresh = await Order.findById(o._id).select('sizeRemaining').lean();
        takeRemaining = Number(fresh?.sizeRemaining) || 0;
      } catch (e) {
        if (e?.code === 'INSUFFICIENT_VAULT' || isInsufficientSharesError(e)) {
          console.warn(
            '[marketMakerQuotes] absorb skip (balance)',
            chainMarketId,
            o.optionKey,
            o.side,
            e.message
          );
          break;
        }
        console.warn('[marketMakerQuotes] absorb', chainMarketId, o._id, e.message || e);
        break;
      }
    }
  }

  return { absorbed };
}

/** Place a single aggressive MM limit on the contra side to complete a user market/partial fill. */
async function placeMmAbsorbLiquidityForOrder({ order, actor, ob, matchId, pollId }) {
  if (!actor?.walletAddress || !order || order.isMarketMaker) return { placed: 0 };

  const remaining = Number(order.sizeRemaining) || 0;
  if (remaining <= 1e-9) return { placed: 0 };

  const st = normOrderStatus(order);
  const isMarket = String(order.orderKind || '').toLowerCase() === 'market';
  if (!isMarket && st !== 'partially_filled' && st !== 'open') return { placed: 0 };

  if ((ob.marketPaused || ob.riskPausedMarket) && order.direction === 'buy') return { placed: 0 };
  if (isOptionSidePaused(ob, order.optionKey, order.side) && order.direction === 'buy') {
    return { placed: 0 };
  }

  const limitPx = Number(order.limitPrice);
  if (!Number.isFinite(limitPx)) return { placed: 0 };

  const mmDirection = order.direction === 'buy' ? 'sell' : 'buy';
  try {
    await placeOrder({
      userId: actor.user._id,
      walletAddress: actor.walletAddress,
      matchId,
      pollId,
      optionKey: order.optionKey,
      side: order.side,
      direction: mmDirection,
      orderKind: 'limit',
      limitPrice: limitPx,
      size: remaining,
      isMarketMaker: true,
    });
    return { placed: 1 };
  } catch (e) {
    if (e?.code === 'INSUFFICIENT_VAULT' || isInsufficientSharesError(e)) {
      return { placed: 0 };
    }
    console.warn('[marketMakerQuotes] absorb liquidity', order._id, e.message || e);
    return { placed: 0 };
  }
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
  pauseMmAsks,
  placeMmOrder,
  basePayload,
  spreadMult,
  quoteMult,
  preferTarget = false,
}) {
  const levelCount = mmLevelCountForSide(doc, optionKey, side, quoteMult);
  const book = await getBook(chainMarketId, optionKey, side);
  const bidCount = book.bids?.length || 0;
  const askCount = book.asks?.length || 0;
  const needBids = bidCount < levelCount;
  const needAsks = !pauseMmAsks && askCount < levelCount;
  if (!needBids && !needAsks) return 0;

  const spreadBps = (ob.spreadBps ?? 80) * spreadMult;
  const mid = await resolveQuoteMid({
    doc,
    optionKey,
    side,
    chainMarketId,
    mmWalletLower,
    preferTarget,
  });
  const built = buildLevelPrices({ ...ob, spreadBps }, mid, levelCount);
  const clamped = clampPassiveLevels(
    built.bids,
    built.asks,
    book,
    mmWalletLower,
    built.tick,
    preferTarget
  );
  const bids = clamped.bids;
  const asks = clamped.asks;
  const { bidSizes, askSizes } = mmLevelSizesForSide(doc, optionKey, side, bids, asks, quoteMult);

  let placed = 0;

  for (let i = bidCount; i < levelCount; i++) {
    const bidPx = bids[Math.min(i, bids.length - 1)];
    const q = bidSizes[i] ?? bidSizes[bidSizes.length - 1] ?? 1;
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

  for (let i = askCount; i < levelCount && !pauseMmAsks; i++) {
    const askPx = asks[Math.min(i, asks.length - 1)];
    const q = askSizes[i] ?? askSizes[askSizes.length - 1] ?? 1;
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

  // pauseNewBuys kept for call-site clarity (MM bids still allowed via assertSideNotPaused)
  void pauseNewBuys;

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
    withOrderbookContractOrLegacy({
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

/** Cancel every resting MM quote on a chain market (all outcomes / sides). */
async function cancelAllMmQuotesForMarket(chainMarketId, mmWalletLower) {
  await Order.updateMany(
    withOrderbookContractOrLegacy({
      chainMarketId,
      walletAddress: mmWalletLower,
      isMarketMaker: true,
      status: { $in: ['open', 'partially_filled', 'pending'] },
    }),
    { $set: { status: 'cancelled', reservedCollateral: 0, sizeRemaining: 0 } }
  );
}

/** Keep at most LEVELS MM orders per direction and enforce per-side volume cap (USDC notional). */
async function trimMmQuotesToVolumeCap({ chainMarketId, mmWalletLower, doc, optionKey, side }) {
  const sideVol = sideVolumeUsdc(doc, optionKey, side);
  const maxBidNotional = sideVol / 2;
  const maxAskNotional = sideVol / 2;
  const maxLevels = mmLevelCountForSide(doc, optionKey, side);

  for (const [direction, cap] of [
    ['buy', maxBidNotional],
    ['sell', maxAskNotional],
  ]) {
    const sort = direction === 'buy' ? { limitPrice: -1, createdAt: 1 } : { limitPrice: 1, createdAt: 1 };
    let orders = await Order.find(
      withOrderbookContract({
        chainMarketId,
        walletAddress: mmWalletLower,
        isMarketMaker: true,
        optionKey,
        side,
        direction,
        status: { $in: ['open', 'partially_filled', 'pending'] },
        sizeRemaining: { $gt: 1e-9 },
      })
    )
      .sort(sort)
      .lean();

    if (orders.length > maxLevels) {
      for (const o of orders.slice(maxLevels)) {
        await Order.updateOne(
          { _id: o._id },
          { $set: { status: 'cancelled', reservedCollateral: 0, sizeRemaining: 0 } }
        );
      }
      orders = orders.slice(0, maxLevels);
    }

    let notional = orders.reduce(
      (s, o) => s + (Number(o.sizeRemaining) || 0) * (Number(o.limitPrice) || 0),
      0
    );
    while (notional > cap + 0.01 && orders.length > 0) {
      const drop = orders.pop();
      await Order.updateOne(
        { _id: drop._id },
        { $set: { status: 'cancelled', reservedCollateral: 0, sizeRemaining: 0 } }
      );
      notional = orders.reduce(
        (s, o) => s + (Number(o.sizeRemaining) || 0) * (Number(o.limitPrice) || 0),
        0
      );
    }
  }
}

/** Cancel all MM resting quotes for a market, then repost from current startingPrices / controls. */
async function forceRequoteMarketMm(doc, kind) {
  const actor = await getMarketMakerActor();
  if (!actor || !doc?.marketId) {
    return { skipped: true, reason: 'MM actor or marketId missing' };
  }
  const mmWalletLower = String(actor.walletAddress).toLowerCase();
  // Full wipe (incl. leftover Draw books from reused marketIds) then target requote.
  await cancelAllMmQuotesForMarket(doc.marketId, mmWalletLower);

  const Model = kind === 'match' ? Match : Poll;
  const latchMs = Math.max(
    30_000,
    parseInt(process.env.MM_PREFER_TARGET_LATCH_MS || '180000', 10) || 180_000
  );
  await Model.updateOne(
    { _id: doc._id },
    { $set: { 'orderbook.mmPreferTargetUntil': new Date(Date.now() + latchMs) } }
  );

  // Prefer admin target mids so saving new odds pulls the book toward that target.
  return ensureQuotesForDoc(doc, kind, { preferTarget: true });
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
    withOrderbookContractOrLegacy({
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
 * Fair mid follows the live book (not only admin startingPrices). Admin force-requote
 * passes preferTarget so new odds are posted at the configured startingPrices.
 *
 * Note: Admin "initial liquidity" (batchAddOrderbookLiquidity) is on-chain only;
 * the CLOB matcher uses MongoDB orders — this is what makes market orders work.
 */
async function ensureQuotesForDoc(doc, kind, opts = {}) {
  let preferTarget = opts.preferTarget === true;
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
  // preferTarget / force still posts when bot is paused (ops can pause production cron pollution).
  if (ob0.botEnabled === false && !preferTarget && opts.force !== true) {
    return { skipped: true, reason: 'bot disabled' };
  }
  if (!doc.marketId) {
    return { skipped: true, reason: 'no chain marketId' };
  }

  // After admin/force requote, keep posting at targets until latch expires (beats concurrent live ticks).
  const latchUntil = ob0.mmPreferTargetUntil ? new Date(ob0.mmPreferTargetUntil).getTime() : 0;
  if (!preferTarget && latchUntil > Date.now()) {
    preferTarget = true;
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
  // On force target requote, wipe any concurrent bot quotes first, place clean book, then absorb.
  if (preferTarget) {
    await cancelAllMmQuotesForMarket(chainMarketId, mmWalletLower);
  } else {
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
  }

  let driftCancels = 0;

  const coherentMids = await resolveCoherentMids({
    doc,
    optionKeys,
    chainMarketId,
    mmWalletLower,
    preferTarget,
  });

  for (const optionKey of optionKeys) {
    for (const side of ['YES', 'NO']) {
      const sidePaused = isOptionSidePaused(ob, optionKey, side);
      // Risk/manual pause blocks new user buys and MM asks (assertSideNotPaused).
      // MM bids still allowed so users can exit.
      const pauseNewBuys = marketPausedForBuys || sidePaused;
      const pauseMmAsks = pauseNewBuys;

      const widen = side === 'YES' ? yesWiden : noWiden;
      const spreadMult = widen ? 2.5 : 1;
      const quoteMult = widen ? 0.4 : 1;
      const levelCount = mmLevelCountForSide(doc, optionKey, side, quoteMult);
      const spreadBps = (ob.spreadBps ?? 80) * spreadMult;

      const mid = coherentMids[optionKey]?.[side] ?? targetMidForOutcome(doc, optionKey, side);

      // If resting MM quotes are centered far from live fair mid, OR the book is crossed, cancel and repost.
      if (!preferTarget) {
        let liveBook;
        try {
          liveBook = await getBook(chainMarketId, optionKey, side);
        } catch {
          liveBook = { bids: [], asks: [] };
        }
        const bb = liveBook.bids?.[0]?.limitPrice != null ? Number(liveBook.bids[0].limitPrice) : null;
        const ba = liveBook.asks?.[0]?.limitPrice != null ? Number(liveBook.asks[0].limitPrice) : null;
        const crossed = bb != null && ba != null && bb >= ba - 1e-9;
        const center = await mmOwnQuoteCenter({
          chainMarketId,
          optionKey,
          side,
          mmWalletLower,
        });
        const driftThresh = Math.max(MID_DRIFT_ABS, ((ob.spreadBps ?? 80) / 10000) * 0.75);
        if (crossed || (center != null && Math.abs(center - mid) > driftThresh)) {
          await cancelMmQuotesForOptionSide(chainMarketId, mmWalletLower, optionKey, side);
          driftCancels += 1;
        }
      } else {
        // PreferTarget: cancel this side again so concurrent ticks cannot leave stale levels.
        await cancelMmQuotesForOptionSide(chainMarketId, mmWalletLower, optionKey, side);
      }

      let book;
      try {
        book = await getBook(chainMarketId, optionKey, side);
      } catch {
        book = { bids: [], asks: [] };
      }

      const built = buildLevelPrices({ ...ob, spreadBps }, mid, levelCount);
      const clamped = clampPassiveLevels(
        built.bids,
        built.asks,
        book,
        mmWalletLower,
        built.tick,
        preferTarget
      );
      const bids = clamped.bids;
      const asks = clamped.asks;
      const { bidSizes, askSizes } = mmLevelSizesForSide(doc, optionKey, side, bids, asks, quoteMult);

      for (let i = 0; i < levelCount; i++) {
        const bidPx = bids[i];
        const qBid = bidSizes[i] ?? 1;
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
            size: qBid,
          });
        }
      }

      if (!pauseMmAsks) {
        for (let i = 0; i < levelCount; i++) {
          const askPx = asks[i];
          const qAsk = askSizes[i] ?? 1;
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
              size: qAsk,
            });
          }
        }
      }

      await trimMmQuotesToVolumeCap({
        chainMarketId,
        mmWalletLower,
        doc,
        optionKey,
        side,
      });

      const depthPlaced = await ensureMinBookDepth({
        doc,
        ob,
        chainMarketId,
        optionKey,
        side,
        mmWalletLower,
        pauseNewBuys,
        pauseMmAsks,
        placeMmOrder,
        basePayload,
        spreadMult,
        quoteMult,
        preferTarget,
      });
      if (depthPlaced > 0) {
        for (let n = 0; n < depthPlaced; n++) placedIds.push('depth');
      }
    }
  }

  if (preferTarget) {
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
      console.warn('[marketMakerQuotes] absorb after target requote', doc.marketId, e.message || e);
    }
  }

  ob.mmWidenActiveYes = yesWiden;
  ob.mmWidenActiveNo = noWiden;

  if (placedIds.length || widenLatchDirty || absorbedCount > 0 || driftCancels > 0) {
    ob.botLastTickAt = new Date();
    doc.orderbook = ob;
    await doc.save();
    return {
      ok: true,
      placedNewCount: placedIds.length,
      absorbedCount,
      driftCancels,
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
  placeMmAbsorbLiquidityForOrder,
  absorbUserCrossingAndPartialOrders,
  resolveQuoteMid,
  resolveCoherentMids,
  cancelAllMmQuotesForMarket,
  LEVELS,
};
