const { ethers } = require('ethers');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const OrderbookPosition = require('../models/OrderbookPosition');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Settings = require('../models/Settings');
const WalletLink = require('../models/WalletLink');
const SettlementOutbox = require('../models/SettlementOutbox');
const { processSettlementOutboxBatch, applyLegsToOrderbookPositions } = require('./settlementOutbox');
const { getContractAddress, getJsonRpcProvider } = require('../utils/chainConfig');
const {
  orderbookContractAddressLower,
  withOrderbookContract,
  withOrderbookContractOrLegacy,
} = require('../utils/orderbookContractScope');
const { getResolvedChainMarketIdSet } = require('../utils/resolvedMarkets');
const { getWeRgameAbiSync } = require('../utils/wergameContractAbi');

const USDC_DECIMALS = parseInt(process.env.USDC_DECIMALS || '6', 10);

function toUnits(amountFloat) {
  const n = typeof amountFloat === 'number' ? amountFloat : parseFloat(amountFloat);
  if (!Number.isFinite(n)) throw new Error('Invalid amount');
  return ethers.parseUnits(n.toFixed(USDC_DECIMALS), USDC_DECIMALS);
}

function unitsToFloat(bi) {
  return parseFloat(ethers.formatUnits(bi, USDC_DECIMALS));
}

async function getFees() {
  const getFee = async (key, defaultValue) => {
    const setting = await Settings.findOne({ key });
    return setting
      ? typeof setting.value === 'number'
        ? setting.value
        : parseFloat(setting.value) || defaultValue
      : defaultValue;
  };
  return {
    marketPlatformFee: await getFee('marketPlatformFee', 5),
    freeJackpotFee: await getFee('freeJackpotFee', 5),
  };
}

async function getOrderbookDefaults() {
  const s = await Settings.findOne({ key: 'orderbookDefaults' });
  const v = s && s.value && typeof s.value === 'object' ? s.value : {};
  return {
    spreadBps: v.spreadBps ?? 80,
    minSpreadFloorBps: v.minSpreadFloorBps ?? 20,
    quoteSizeUsdc: v.quoteSizeUsdc ?? 50,
    maxSlippageBps: v.maxSlippageBps ?? 300,
    maxTreasuryLossUsdc: v.maxTreasuryLossUsdc ?? 100000,
    maxTreasuryLossYesUsdc: v.maxTreasuryLossYesUsdc ?? 50000,
    maxTreasuryLossNoUsdc: v.maxTreasuryLossNoUsdc ?? 50000,
    maxMarketAllocationUsdc: v.maxMarketAllocationUsdc ?? 250000,
    widenSpreadYesCapUsdc: v.widenSpreadYesCapUsdc ?? 0,
    widenSpreadNoCapUsdc: v.widenSpreadNoCapUsdc ?? 0,
  };
}

function orderSideBookKey(chainMarketId, optionKey, side) {
  return JSON.stringify([Number(chainMarketId), String(optionKey), String(side)]);
}

/** Preload opposite-side sell books for many (market, outcome, side) keys — one query per key, in parallel. */
async function sellBookCacheForKeys(keySet) {
  const bookCache = new Map();
  const keys = [...keySet];
  await Promise.all(
    keys.map(async (key) => {
      const [chainMarketId, optionKey, side] = JSON.parse(key);
      const resting = await Order.find(
        withOrderbookContract({
          chainMarketId,
          optionKey,
          side,
          direction: 'sell',
          status: { $in: ['open', 'partially_filled'] },
        })
      )
        .sort({ limitPrice: 1, createdAt: 1 })
        .lean();
      bookCache.set(key, resting);
    })
  );
  return bookCache;
}

/**
 * Worst-case USDC this new BUY LIMIT needs from the vault: immediate fills (notional + fee)
 * plus USDC locked for any unfilled remainder (remaining × limit), mirroring runMatch.
 */
function estimateBuyLimitVaultNeedUsdFromBook(resting, walletLower, size, limitPx, fees) {
  let remaining = size;
  let immediateOut = 0;
  const feeRate = (fees.marketPlatformFee + fees.freeJackpotFee) / 100;
  const w = String(walletLower || '').toLowerCase();

  for (const maker of resting) {
    if (remaining <= 1e-9) break;
    if (String(maker.walletAddress || '').toLowerCase() === w) continue;
    if (maker.limitPrice > limitPx) break;
    const tradeSize = Math.min(remaining, Number(maker.sizeRemaining) || 0);
    if (tradeSize <= 1e-9) continue;
    const notional = tradeSize * maker.limitPrice;
    const fee = notional * feeRate;
    immediateOut += notional + fee;
    remaining = parseFloat((remaining - tradeSize).toFixed(6));
  }

  const restLock = remaining > 1e-9 ? parseFloat((remaining * limitPx).toFixed(6)) : 0;
  return parseFloat((immediateOut + restLock).toFixed(6));
}

async function estimateBuyLimitVaultNeedUsd(chainMarketId, optionKey, side, walletLower, size, limitPx, fees) {
  const resting = await Order.find(
    withOrderbookContract({
      chainMarketId,
      optionKey,
      side,
      direction: 'sell',
      status: { $in: ['open', 'partially_filled'] },
    })
  )
    .sort({ limitPrice: 1, createdAt: 1 })
    .lean();
  return estimateBuyLimitVaultNeedUsdFromBook(resting, walletLower, size, limitPx, fees);
}

/**
 * Worst-case vault USDC still locked for an open/partial buy order (must match placeOrder / runMatch).
 * @param {unknown[]|null|undefined} restingSellsBook — when set, skips DB (batch vault / MM paths).
 */
async function computeBuyReservedUsd(order, fees, restingSellsBook) {
  if (!order || order.direction !== 'buy') return 0;
  const rem = Number(order.sizeRemaining);
  if (!Number.isFinite(rem) || rem <= 1e-9) return 0;
  if (order.orderKind === 'market') {
    const px = Number(order.limitPrice);
    if (!Number.isFinite(px) || px <= 0) return 0;
    return parseFloat((rem * px).toFixed(6));
  }
  const w = String(order.walletAddress || '').toLowerCase();
  const lim = Number(order.limitPrice);
  if (restingSellsBook != null) {
    return estimateBuyLimitVaultNeedUsdFromBook(restingSellsBook, w, rem, lim, fees);
  }
  return await estimateBuyLimitVaultNeedUsd(order.chainMarketId, order.optionKey, order.side, w, rem, lim, fees);
}

function mergeControl(item) {
  const ob = item.orderbook || {};
  return { ...ob };
}

function positionKey(optionKey, side) {
  return `${optionKey}|${side}`;
}

async function readVaultBalance(wallet) {
  const addr = getContractAddress();
  if (!addr) return 0;
  const provider = getJsonRpcProvider();
  const c = new ethers.Contract(addr, getWeRgameAbiSync(), provider);
  const bal = await c.tradingVaultBalances(ethers.getAddress(wallet));
  return unitsToFloat(bal);
}

/** USDC not yet debited on-chain but committed in a pending/processing settlement batch (net per job). */
async function pendingVaultDebitForWallet(walletLower) {
  const c = orderbookContractAddressLower();
  if (!c) return 0;
  const resolvedIds = await getResolvedChainMarketIdSet();
  const jobs = await SettlementOutbox.find(
    withOrderbookContract({
      status: { $in: ['pending', 'processing'] },
    })
  )
    .select('legs chainMarketId contractAddress')
    .lean();
  let total = 0;
  for (const job of jobs) {
    if (resolvedIds.has(Number(job.chainMarketId))) continue;
    if (job.contractAddress && String(job.contractAddress).toLowerCase() !== c) continue;
    let net = 0;
    for (const leg of job.legs || []) {
      if (String(leg.user).toLowerCase() !== walletLower) continue;
      try {
        net += parseFloat(ethers.formatUnits(BigInt(leg.vaultDelta || '0'), USDC_DECIMALS));
      } catch {
        /* skip malformed leg */
      }
    }
    if (net < -1e-12) total += -net;
  }
  return parseFloat(total.toFixed(6));
}

async function openBuyOrderReservedUsd(walletLower) {
  const fees = await getFees();
  const resolvedIds = await getResolvedChainMarketIdSet();
  const orders = await Order.find(
    withOrderbookContract({
      walletAddress: walletLower,
      direction: 'buy',
      status: { $in: ['open', 'partially_filled'] },
      sizeRemaining: { $gt: 1e-9 },
    })
  )
    .select('chainMarketId optionKey side walletAddress sizeRemaining limitPrice orderKind direction')
    .lean();
  if (!orders.length) return 0;
  const keySet = new Set();
  for (const o of orders) {
    if (resolvedIds.has(Number(o.chainMarketId))) continue;
    if (o.orderKind === 'limit') keySet.add(orderSideBookKey(o.chainMarketId, o.optionKey, o.side));
  }
  const bookCache = await sellBookCacheForKeys(keySet);
  let total = 0;
  for (const o of orders) {
    if (resolvedIds.has(Number(o.chainMarketId))) continue;
    const book = o.orderKind === 'limit' ? bookCache.get(orderSideBookKey(o.chainMarketId, o.optionKey, o.side)) : null;
    total += await computeBuyReservedUsd(o, fees, book);
  }
  return parseFloat(total.toFixed(6));
}

/** Vault USDC that must not be withdrawn: open buy orders + unsettled trade debits. */
async function reservedCollateralForWallet(walletLower) {
  const [openOrders, pendingSettle] = await Promise.all([
    openBuyOrderReservedUsd(walletLower),
    pendingVaultDebitForWallet(walletLower),
  ]);
  return parseFloat((openOrders + pendingSettle).toFixed(6));
}

async function loadItem(matchId, pollId) {
  if (matchId) {
    const m = await Match.findById(matchId);
    if (!m) throw Object.assign(new Error('Match not found'), { statusCode: 404 });
    return { kind: 'match', item: m };
  }
  if (pollId) {
    const p = await Poll.findById(pollId);
    if (!p) throw Object.assign(new Error('Poll not found'), { statusCode: 404 });
    return { kind: 'poll', item: p };
  }
  throw Object.assign(new Error('matchId or pollId required'), { statusCode: 400 });
}

function assertTradable(item) {
  if (item.status === 'locked' || item.status === 'completed' || item.isResolved) {
    throw Object.assign(new Error('Market not tradable'), { statusCode: 400 });
  }
  if (!item.marketId) {
    throw Object.assign(new Error('No chain market'), { statusCode: 400 });
  }
  if (item.orderbook && item.orderbook.enabled === false) {
    throw Object.assign(new Error('Orderbook disabled for this market'), { statusCode: 400 });
  }
}

function getOptionPauseFlags(ob, optionKey) {
  const list = ob?.pauseByOption || [];
  const row = list.find((r) => String(r.optionKey) === String(optionKey));
  return {
    pauseYes: !!(row?.pauseYes),
    pauseNo: !!(row?.pauseNo),
  };
}

function isOptionSidePaused(ob, optionKey, side) {
  if (!ob) return false;
  const perOpt = optionKey ? getOptionPauseFlags(ob, optionKey) : { pauseYes: false, pauseNo: false };
  if (side === 'YES') {
    return !!(ob.pauseSideYes || ob.riskPausedYes || perOpt.pauseYes);
  }
  if (side === 'NO') {
    return !!(ob.pauseSideNo || ob.riskPausedNo || perOpt.pauseNo);
  }
  return false;
}

function assertSideNotPaused(item, side, optionKey, opts = {}) {
  const { direction = 'buy', isMarketMaker = false } = opts;
  const ob = item.orderbook || {};
  const sidePaused = isOptionSidePaused(ob, optionKey, side);
  const marketPausedForBuys = !!(ob.marketPaused || ob.riskPausedMarket);

  // Users closing positions may always sell (reduces treasury exposure).
  if (direction === 'sell' && !isMarketMaker) return;

  // MM bids provide exit liquidity even when buys are paused.
  if (isMarketMaker && direction === 'buy') return;

  if (marketPausedForBuys) {
    throw Object.assign(new Error('Market is paused for new buys'), { statusCode: 400 });
  }
  if (sidePaused) {
    throw Object.assign(
      new Error(optionKey ? `${side} side paused for new buys on ${optionKey}` : `${side} side paused for new buys`),
      { statusCode: 400 }
    );
  }
}

/**
 * Match incoming against resting opposite-side orders (price–time priority CLOB).
 *
 * CORE RULES (same side = same outcome YES/NO token):
 * - Incoming BUY limit matches resting SELLS from lowest ask upward (cheapest liquidity first).
 *   Stops when no asks remain at or below the buy limit → remainder stays passive (open on book).
 * - Incoming SELL limit matches resting BUYS from highest bid downward.
 *   Stops when no bids remain at or above the sell limit → remainder stays passive.
 * - A limit is “marketable” only if it crosses the contra book at those prices; otherwise fills.length === 0
 *   and the order stays fully open. Partial crosses fill up to size then rest the remainder.
 * - Fills execute at the maker’s limit price (price improvement for the taker vs their own limit when more aggressive).
 *
 * Mutates incomingDoc + touched makers; returns { fills, touched } for settlement packaging.
 */
async function runMatch(incomingDoc, fees, session = null) {
  const oppositeDir = incomingDoc.direction === 'buy' ? 'sell' : 'buy';
  const sort =
    incomingDoc.direction === 'buy'
      ? { limitPrice: 1, createdAt: 1 }
      : { limitPrice: -1, createdAt: 1 };

  let q = Order.find(
    withOrderbookContract({
      chainMarketId: incomingDoc.chainMarketId,
      optionKey: incomingDoc.optionKey,
      side: incomingDoc.side,
      direction: oppositeDir,
      status: { $in: ['open', 'partially_filled'] },
      _id: { $ne: incomingDoc._id },
    })
  ).sort(sort);
  if (session) q = q.session(session);
  const resting = await q;

  let remaining = Math.max(0, Number(incomingDoc.sizeRemaining) || 0);
  const incomingLimit = Number(incomingDoc.limitPrice);
  const fills = [];
  const touched = [];

  const feeRate = (fees.marketPlatformFee + fees.freeJackpotFee) / 100;
  const jpRate = (Number(fees.freeJackpotFee) || 0) / 100;

  const incomingWallet = String(incomingDoc.walletAddress || '').toLowerCase();
  for (const maker of resting) {
    if (remaining <= 1e-9) break;
    if (String(maker.walletAddress || '').toLowerCase() === incomingWallet) continue;
    const mkPx = Number(maker.limitPrice);
    if (!Number.isFinite(mkPx)) continue;
    if (incomingDoc.direction === 'buy' && mkPx > incomingLimit + 1e-9) break;
    if (incomingDoc.direction === 'sell' && mkPx < incomingLimit - 1e-9) break;

    const tradePx = mkPx;
    const mkRem = Math.max(0, Number(maker.sizeRemaining) || 0);
    const tradeSize = Math.min(remaining, mkRem);
    if (tradeSize <= 1e-9) continue;

    const notional = tradeSize * tradePx;
    const feeJackpot = notional * jpRate;
    const feePlatform = parseFloat((notional * feeRate - feeJackpot).toFixed(12));
    const fee = feeJackpot + feePlatform;

    fills.push({
      tradePx,
      tradeSize,
      notional,
      fee,
      feeJackpot,
      feePlatform,
      makerId: maker._id,
      makerWallet: maker.walletAddress,
      makerIsBuy: maker.direction === 'buy',
      takerIsBuy: incomingDoc.direction === 'buy',
    });

    maker.sizeRemaining = parseFloat((mkRem - tradeSize).toFixed(6));
    maker.sizeFilled = parseFloat(((Number(maker.sizeFilled) || 0) + tradeSize).toFixed(6));
    maker.status =
      maker.sizeRemaining <= 1e-9 ? 'filled' : 'partially_filled';
    touched.push(maker);

    remaining = parseFloat((remaining - tradeSize).toFixed(6));
  }

  for (const maker of touched) {
    if (maker.direction === 'buy') {
      maker.reservedCollateral = await computeBuyReservedUsd(maker, fees);
    } else {
      maker.reservedCollateral = 0;
    }
  }

  incomingDoc.sizeRemaining = remaining;
  incomingDoc.sizeFilled = parseFloat((Number(incomingDoc.sizeOriginal) - remaining).toFixed(6));
  if (remaining <= 1e-9) {
    incomingDoc.status = 'filled';
    incomingDoc.reservedCollateral = 0;
  } else {
    incomingDoc.status = incomingDoc.sizeFilled > 1e-9 ? 'partially_filled' : 'open';
    if (incomingDoc.direction === 'buy') {
      incomingDoc.reservedCollateral = await computeBuyReservedUsd(incomingDoc, fees);
    } else {
      incomingDoc.reservedCollateral = 0;
    }
  }

  return { fills, touched };
}

/**
 * Shares that would fill immediately if this sell limit were placed (resting bids at or above limit).
 * Passive asks above the best bid do not require inventory upfront.
 */
async function estimateImmediatelyMatchableSellShares(chainMarketId, optionKey, side, walletLower, limitPrice, size) {
  const sz = Math.max(0, Number(size) || 0);
  if (sz <= 1e-9) return 0;
  const lp = Number(limitPrice);
  if (!Number.isFinite(lp)) return 0;

  const resting = await Order.find(
    withOrderbookContract({
      chainMarketId,
      optionKey,
      side,
      direction: 'buy',
      status: { $in: ['open', 'partially_filled'] },
    })
  )
    .sort({ limitPrice: -1, createdAt: 1 })
    .lean();

  let remaining = sz;
  let marketable = 0;
  const w = String(walletLower).toLowerCase();
  for (const maker of resting) {
    if (remaining <= 1e-9) break;
    if (String(maker.walletAddress || '').toLowerCase() === w) continue;
    const mkPx = Number(maker.limitPrice);
    if (!Number.isFinite(mkPx) || mkPx < lp - 1e-9) break;
    const mkRem = Math.max(0, Number(maker.sizeRemaining) || 0);
    const take = Math.min(remaining, mkRem);
    marketable += take;
    remaining -= take;
  }
  return parseFloat(marketable.toFixed(6));
}

async function continueOrderMatchSettlement(orderId, item, kind, fees) {
  const matchId = kind === 'match' ? item._id : undefined;
  const pollId = kind === 'poll' ? item._id : undefined;
  const contractLower = orderbookContractAddressLower();
  let ledgerApply = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const fresh = await Order.findById(orderId).session(session);
      if (!fresh) return;
      if (!['open', 'partially_filled', 'pending'].includes(fresh.status)) return;
      if (Number(fresh.sizeRemaining) <= 1e-9) return;
      const { fills, touched } = await runMatch(fresh, fees, session);
      if (fills.length === 0) return;
      const { legs, feeToClaimPool, feeToJackpotPool, feePlatformUsd, feeJackpotUsd } = buildSettlementLegs(
        fresh,
        fills
      );
      for (const m of touched) await m.save({ session });
      await fresh.save({ session });
      if (feeJackpotUsd > 1e-12 || feePlatformUsd > 1e-12) {
        if (matchId) {
          await Match.updateOne(
            { _id: matchId },
            { $inc: { freeJackpotPool: feeJackpotUsd, platformFees: feePlatformUsd } }
          ).session(session);
        } else if (pollId) {
          await Poll.updateOne(
            { _id: pollId },
            { $inc: { freeJackpotPool: feeJackpotUsd, platformFees: feePlatformUsd } }
          ).session(session);
        }
      }
      const [outDoc] = await SettlementOutbox.create(
        [
          {
            contractAddress: contractLower,
            chainMarketId: item.marketId,
            legs,
            feeToClaimPool,
            feeToJackpotPool,
            orderIds: [fresh._id, ...touched.map((t) => t._id)],
            status: 'pending',
          },
        ],
        { session }
      );
      ledgerApply = { chainMarketId: item.marketId, legs, contractLower, outId: outDoc._id };
    });
  } catch (e) {
    console.warn('continueOrderMatchSettlement', String(orderId), e.message || e);
  } finally {
    await session.endSession();
  }
  if (ledgerApply) {
    try {
      await applyLegsToOrderbookPositions(ledgerApply.chainMarketId, ledgerApply.legs, ledgerApply.contractLower);
      await SettlementOutbox.updateOne(
        { _id: ledgerApply.outId },
        { $set: { positionsLedgerApplied: true, updatedAt: new Date() } }
      );
    } catch (e) {
      console.error('continueOrderMatchSettlement ledger', e.message || e);
    }
  }
}

async function tryCompleteUserOrderFill(orderId, item, kind, fees) {
  const {
    ensureQuotesForDoc,
    absorbUserCrossingAndPartialOrders,
    placeMmAbsorbLiquidityForOrder,
    getMarketMakerActor,
    syncOrderbookRiskToDb,
  } = require('./marketMakerQuotes');
  const matchId = kind === 'match' ? item._id : undefined;
  const pollId = kind === 'poll' ? item._id : undefined;
  const isUserMarket = async () => {
    const o = await Order.findById(orderId).lean();
    return String(o?.orderKind || '').toLowerCase() === 'market';
  };

  for (let attempt = 0; attempt < 12; attempt++) {
    const before = await Order.findById(orderId).lean();
    if (!before || Number(before.sizeRemaining) <= 1e-9) break;
    if (!['open', 'partially_filled', 'pending'].includes(String(before.status))) break;

    await ensureQuotesForDoc(item, kind);
    await continueOrderMatchSettlement(orderId, item, kind, fees);

    const mid = await Order.findById(orderId).lean();
    if (!mid || Number(mid.sizeRemaining) <= 1e-9) break;

    const actor = await getMarketMakerActor();
    if (actor) {
      const risk = await syncOrderbookRiskToDb(item, kind);
      if (risk?.patch) {
        item.orderbook = { ...(item.orderbook || {}), ...risk.patch };
      }
      const ob = item.orderbook || {};
      await absorbUserCrossingAndPartialOrders({
        doc: item,
        kind,
        actor,
        ob,
        riskPausedYes: !!(ob.pauseSideYes || ob.riskPausedYes),
        riskPausedNo: !!(ob.pauseSideNo || ob.riskPausedNo),
        matchId,
        pollId,
      });
      await placeMmAbsorbLiquidityForOrder({
        order: mid,
        actor,
        ob,
        matchId,
        pollId,
      });
      await continueOrderMatchSettlement(orderId, item, kind, fees);
    }

    const after = await Order.findById(orderId).lean();
    if (!after || Number(after.sizeRemaining) <= 1e-9) break;
    const progressed = Number(after.sizeRemaining) < Number(before.sizeRemaining) - 1e-9;
    const marketOrder = await isUserMarket();
    if (!progressed && !marketOrder && attempt >= 1) break;
  }
}

function buildSettlementLegs(incomingDoc, fills) {
  const legsMap = new Map();
  const pk = positionKey(incomingDoc.optionKey, incomingDoc.side);
  let totalFeePlatform = 0;
  let totalFeeJackpot = 0;

  function bump(user, vaultDeltaFloat, sharesDeltaFloat, investedDeltaFloat) {
    const k = user.toLowerCase();
    if (!legsMap.has(k)) {
      legsMap.set(k, {
        user: ethers.getAddress(user),
        vaultDelta: 0n,
        sharesDelta: 0n,
        investedDelta: 0n,
        positionKey: pk,
      });
    }
    const e = legsMap.get(k);
    e.vaultDelta += toUnits(vaultDeltaFloat);
    e.sharesDelta += toUnits(sharesDeltaFloat);
    e.investedDelta += toUnits(investedDeltaFloat);
  }

  for (const f of fills) {
    totalFeePlatform += Number(f.feePlatform) || 0;
    totalFeeJackpot += Number(f.feeJackpot) || 0;
    const takerWallet = incomingDoc.walletAddress;
    const makerWallet = f.makerWallet;

    if (f.takerIsBuy) {
      bump(takerWallet, -(f.notional + f.fee), f.tradeSize, f.notional);
      bump(makerWallet, f.notional, -f.tradeSize, -f.notional);
    } else {
      bump(takerWallet, f.notional - f.fee, -f.tradeSize, -f.notional);
      bump(makerWallet, -(f.notional), f.tradeSize, f.notional);
    }
  }

  const legs = [...legsMap.values()].map((e) => ({
    user: e.user,
    positionKey: e.positionKey,
    vaultDelta: e.vaultDelta.toString(),
    sharesDelta: e.sharesDelta.toString(),
    investedDelta: e.investedDelta.toString(),
  }));

  const feeClaimWei = toUnits(totalFeePlatform);
  const feeJackpotWei = toUnits(totalFeeJackpot);
  const feePlatformUsd = parseFloat(totalFeePlatform.toFixed(8));
  const feeJackpotUsd = parseFloat(totalFeeJackpot.toFixed(8));
  return {
    legs,
    feeToClaimPool: feeClaimWei.toString(),
    feeToJackpotPool: feeJackpotWei.toString(),
    feePlatformUsd,
    feeJackpotUsd,
  };
}

async function placeOrder(payload) {
  const {
    userId,
    walletAddress,
    matchId,
    pollId,
    optionKey,
    side,
    direction,
    orderKind,
    limitPrice,
    size,
    slippageBps = 100,
    expiresAt,
    isMarketMaker = false,
  } = payload;

  const { kind, item } = await loadItem(matchId, pollId);
  try {
    const { syncOrderbookRiskToDb } = require('./marketMakerQuotes');
    const riskRes = await syncOrderbookRiskToDb(item, kind);
    if (riskRes?.patch) {
      item.orderbook = { ...(item.orderbook || {}), ...riskRes.patch };
    }
  } catch (e) {
    console.warn('orderbook risk sync:', e.message || e);
  }
  assertTradable(item);
  assertSideNotPaused(item, side, optionKey, { direction, isMarketMaker: !!isMarketMaker });

  const contractLower = orderbookContractAddressLower();
  if (!contractLower) {
    throw Object.assign(new Error('CONTRACT_ADDRESS is not configured; cannot trade on orderbook'), {
      statusCode: 503,
    });
  }

  const w = String(walletAddress).trim().toLowerCase();
  const link = await WalletLink.findOne({ walletAddress: w }).lean();
  if (!link || String(link.user) !== String(userId)) {
    throw Object.assign(new Error('Wallet not linked to user'), { statusCode: 403 });
  }

  let px;
  if (orderKind === 'market') {
    if (!isMarketMaker) {
      try {
        const { ensureQuotesForDoc } = require('./marketMakerQuotes');
        await ensureQuotesForDoc(item, kind);
      } catch (e) {
        console.warn('orderbook mm pre-quote before market order:', e.message || e);
      }
    }
    const oppositeDir = direction === 'buy' ? 'sell' : 'buy';
    const sort = direction === 'buy' ? { limitPrice: 1 } : { limitPrice: -1 };
    const findBest = () =>
      Order.findOne(
        withOrderbookContract({
          chainMarketId: item.marketId,
          optionKey,
          side,
          direction: oppositeDir,
          status: { $in: ['open', 'partially_filled'] },
        })
      ).sort(sort);

    let best = await findBest();
    if (!best && !isMarketMaker) {
      try {
        const { ensureQuotesForDoc } = require('./marketMakerQuotes');
        await ensureQuotesForDoc(item, kind);
        best = await findBest();
      } catch (e) {
        console.warn('orderbook mm top-up before market order:', e.message || e);
      }
    }
    if (!best) {
      throw Object.assign(new Error('No liquidity to match market order'), { statusCode: 400 });
    }
    const obSlipBps = Math.max(
      Number(slippageBps) || 100,
      Number(item.orderbook?.maxSlippageBps) || 300
    );
    const slip = obSlipBps / 10000;
    if (direction === 'buy') {
      px = Math.min(0.99, best.limitPrice * (1 + slip));
    } else {
      px = Math.max(0.01, best.limitPrice * (1 - slip));
    }
  } else {
    px = parseFloat(limitPrice);
    if (!Number.isFinite(px)) {
      throw Object.assign(new Error('Limit price is required (0–1)'), {
        statusCode: 400,
        code: 'INVALID_LIMIT_PRICE',
      });
    }
  }

  if (!Number.isFinite(px) || px < 0.01 || px > 0.99) {
    throw Object.assign(new Error('Invalid price (0.01–0.99)'), { statusCode: 400, code: 'INVALID_LIMIT_PRICE' });
  }
  const sz = parseFloat(size);
  if (!Number.isFinite(sz) || sz <= 0) {
    throw Object.assign(new Error('Invalid size'), { statusCode: 400 });
  }

  const fees = await getFees();

  const [vault, reserved] = await Promise.all([readVaultBalance(w), reservedCollateralForWallet(w)]);
  const available = vault - reserved;

  let maxReserve = 0;
  if (direction === 'buy') {
    if (orderKind === 'market') {
      maxReserve = parseFloat((sz * px).toFixed(6));
    } else {
      maxReserve = await estimateBuyLimitVaultNeedUsd(item.marketId, optionKey, side, w, sz, px, fees);
    }
  }

  if (direction === 'buy' && available < maxReserve - 1e-6) {
    throw Object.assign(new Error('Insufficient vault balance for this order'), {
      statusCode: 400,
      code: 'INSUFFICIENT_VAULT',
      details: {
        requiredUsdc: maxReserve,
        availableUsdc: Math.max(0, available),
        vaultUsdc: vault,
        reservedUsdc: reserved,
      },
    });
  }

  if (direction === 'sell') {
    const pk = positionKey(optionKey, side);
    const pos = await OrderbookPosition.findOne(
      withOrderbookContractOrLegacy({
        walletAddress: w,
        chainMarketId: item.marketId,
        positionKey: pk,
      })
    ).lean();
    const held = Number(pos?.shares) || 0;
    const requiredNow =
      orderKind === 'market'
        ? sz
        : await estimateImmediatelyMatchableSellShares(item.marketId, optionKey, side, w, px, sz);
    if (held < requiredNow - 1e-6) {
      throw Object.assign(new Error('Insufficient shares to sell'), {
        statusCode: 400,
        code: 'INSUFFICIENT_SHARES',
        details: {
          requiredShares: requiredNow,
          orderSize: sz,
          availableShares: held,
          immediateOnly: orderKind === 'limit',
        },
      });
    }
  }

  const session = await mongoose.startSession();
  let createdId = null;
  /** After commit: apply settlement legs to OrderbookPosition immediately (settlement worker skips if flag set). */
  let ledgerApply = null;
  try {
    await session.withTransaction(async () => {
      const [created] = await Order.create(
        [
          {
            user: userId,
            walletAddress: w,
            contractAddress: contractLower,
            chainMarketId: item.marketId,
            match: matchId || undefined,
            poll: pollId || undefined,
            optionKey,
            side,
            direction,
            orderKind,
            limitPrice: px,
            sizeOriginal: sz,
            sizeRemaining: sz,
            sizeFilled: 0,
            slippageBps,
            status: 'pending',
            expiresAt: expiresAt ? new Date(expiresAt) : null,
            isMarketMaker: !!isMarketMaker,
            reservedCollateral: maxReserve,
          },
        ],
        { session }
      );
      createdId = created._id;
      const fresh = await Order.findById(createdId).session(session);
      const { fills, touched } = await runMatch(fresh, fees, session);

      if (fills.length === 0) {
        fresh.status = 'open';
        await fresh.save({ session });
        return;
      }

      const { legs, feeToClaimPool, feeToJackpotPool, feePlatformUsd, feeJackpotUsd } = buildSettlementLegs(
        fresh,
        fills
      );
      for (const m of touched) await m.save({ session });
      await fresh.save({ session });

      if (feeJackpotUsd > 1e-12 || feePlatformUsd > 1e-12) {
        if (matchId) {
          await Match.updateOne(
            { _id: matchId },
            { $inc: { freeJackpotPool: feeJackpotUsd, platformFees: feePlatformUsd } }
          ).session(session);
        } else if (pollId) {
          await Poll.updateOne(
            { _id: pollId },
            { $inc: { freeJackpotPool: feeJackpotUsd, platformFees: feePlatformUsd } }
          ).session(session);
        }
      }

      const [outDoc] = await SettlementOutbox.create(
        [
          {
            contractAddress: contractLower,
            chainMarketId: item.marketId,
            legs,
            feeToClaimPool,
            feeToJackpotPool,
            orderIds: [fresh._id, ...touched.map((t) => t._id)],
            status: 'pending',
          },
        ],
        { session }
      );
      ledgerApply = {
        chainMarketId: item.marketId,
        legs,
        contractLower,
        outId: outDoc._id,
      };
    });
  } catch (e) {
    if (createdId) {
      await Order.findByIdAndUpdate(createdId, {
        status: 'rejected',
        lastError: e.message,
        reservedCollateral: 0,
      }).catch(() => {});
    }
    await session.endSession();
    throw e;
  }
  await session.endSession();

  if (ledgerApply) {
    try {
      await applyLegsToOrderbookPositions(ledgerApply.chainMarketId, ledgerApply.legs, ledgerApply.contractLower);
      await SettlementOutbox.updateOne(
        { _id: ledgerApply.outId },
        { $set: { positionsLedgerApplied: true, updatedAt: new Date() } }
      );
    } catch (e) {
      console.error('orderbook immediate position ledger:', e.message || e);
      throw Object.assign(new Error('Position update failed after trade'), {
        statusCode: 500,
        code: 'LEDGER_APPLY_FAILED',
      });
    }
  }

  if (!isMarketMaker) {
    setImmediate(() => {
      const { ensureQuotesForDoc } = require('./marketMakerQuotes');
      ensureQuotesForDoc(item, kind).catch((e) => {
        console.warn('orderbook mm/risk refresh after user order:', e.message || e);
      });
    });
  }

  try {
    await processSettlementOutboxBatch(8);
  } catch (err) {
    console.error('orderbook settlement batch:', err.message || err);
  }

  let out = await Order.findById(createdId).lean();
  if (out && out.status === 'pending') {
    const nextStatus =
      Number(out.sizeRemaining) <= 1e-9
        ? 'filled'
        : Number(out.sizeFilled) > 1e-9
          ? 'partially_filled'
          : 'open';
    await Order.updateOne({ _id: createdId }, { $set: { status: nextStatus } });
    out = await Order.findById(createdId).lean();
  }

  if (
    !isMarketMaker &&
    (orderKind === 'market' || String(out?.status || '').toLowerCase() === 'partially_filled')
  ) {
    await tryCompleteUserOrderFill(createdId, item, kind, fees);
    out = await Order.findById(createdId).lean();
    if (out && out.status === 'pending') {
      const nextStatus =
        Number(out.sizeRemaining) <= 1e-9
          ? 'filled'
          : Number(out.sizeFilled) > 1e-9
            ? 'partially_filled'
            : 'open';
      await Order.updateOne({ _id: createdId }, { $set: { status: nextStatus } });
      out = await Order.findById(createdId).lean();
    }
  }

  return out;
}

async function cancelOrder(orderId, userId) {
  const o = await Order.findById(orderId);
  if (!o) throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  if (String(o.user) !== String(userId)) {
    throw Object.assign(new Error('Not authorized'), { statusCode: 403 });
  }
  const c = orderbookContractAddressLower();
  if (c && o.contractAddress && String(o.contractAddress).toLowerCase() !== c) {
    throw Object.assign(new Error('Order belongs to a different contract deployment'), { statusCode: 409 });
  }
  if (!['open', 'partially_filled', 'pending'].includes(o.status)) {
    throw Object.assign(new Error('Order not cancellable'), { statusCode: 400 });
  }
  o.status = 'cancelled';
  o.reservedCollateral = 0;
  o.sizeRemaining = 0;
  await o.save();
  return o;
}

async function getBook(chainMarketId, optionKey, side) {
  const base = withOrderbookContractOrLegacy({
    chainMarketId,
    optionKey,
    side,
    status: { $in: ['open', 'partially_filled'] },
  });
  const bids = await Order.find({ ...base, direction: 'buy' }).sort({ limitPrice: -1, createdAt: 1 }).lean();
  const asks = await Order.find({ ...base, direction: 'sell' }).sort({ limitPrice: 1, createdAt: 1 }).lean();
  return { bids, asks };
}

async function expireStaleOrders() {
  const now = new Date();
  await Order.updateMany(
    withOrderbookContract({
      status: { $in: ['open', 'partially_filled', 'pending'] },
      expiresAt: { $lte: now },
    }),
    { $set: { status: 'expired', reservedCollateral: 0, sizeRemaining: 0 } }
  );
}

function midFromBookSide(bids, asks) {
  const bb = bids?.[0]?.limitPrice != null ? Number(bids[0].limitPrice) : null;
  const ba = asks?.[0]?.limitPrice != null ? Number(asks[0].limitPrice) : null;
  if (bb != null && ba != null) return (bb + ba) / 2;
  if (ba != null) return ba;
  if (bb != null) return bb;
  return null;
}

/**
 * Implied win probability per outcome from YES/NO mids (normalized to sum ≈ 1).
 */
async function impliedProbabilityByOption(chainMarketId, optionKeys, startingPricesRows = []) {
  const keys = (optionKeys || []).map((k) => String(k).trim()).filter(Boolean);
  if (!keys.length) return {};

  const raw = {};
  for (const key of keys) {
    let p = null;
    try {
      const [yesBook, noBook] = await Promise.all([
        getBook(chainMarketId, key, 'YES'),
        getBook(chainMarketId, key, 'NO'),
      ]);
      const yesMid = midFromBookSide(yesBook.bids, yesBook.asks);
      const noMid = midFromBookSide(noBook.bids, noBook.asks);
      if (yesMid != null) p = yesMid;
      else if (noMid != null) p = 1 - noMid;
    } catch {
      /* book may be empty */
    }
    if (p == null) {
      const row = (startingPricesRows || []).find((r) => String(r.optionKey) === key);
      const yp = Number(row?.yesPrice);
      if (Number.isFinite(yp) && yp > 0 && yp < 1) p = yp;
    }
    raw[key] = Math.max(0.001, Math.min(0.999, p ?? 1 / keys.length));
  }

  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const k of Object.keys(raw)) out[k] = raw[k] / sum;
  return out;
}

/**
 * Orderbook trade tape + live implied prices for market charts.
 */
async function getOrderbookMarketActivity(chainMarketId, optionKeys, startingPricesRows = []) {
  const keys = (optionKeys || []).map((k) => String(k).trim()).filter(Boolean);
  const orders = await Order.find({
    ...withOrderbookContract({ chainMarketId }),
    sizeFilled: { $gt: 0 },
  })
    .sort({ updatedAt: 1 })
    .limit(400)
    .select('optionKey side limitPrice sizeFilled updatedAt createdAt direction isMarketMaker')
    .lean();

  const trades = orders.map((o) => ({
    t: o.updatedAt || o.createdAt,
    optionKey: String(o.optionKey || ''),
    side: o.side,
    price: Number(o.limitPrice) || 0,
    size: Number(o.sizeFilled) || 0,
    direction: o.direction,
    isMarketMaker: !!o.isMarketMaker,
  }));

  const impliedNow = await impliedProbabilityByOption(chainMarketId, keys, startingPricesRows);
  return { trades, impliedNow };
}

/**
 * Single round-trip snapshot: all order books + trade tape + implied prices (no duplicate getBook).
 */
async function getMarketSnapshot(chainMarketId, optionKeys, startingPricesRows = []) {
  const keys = (optionKeys || []).map((k) => String(k).trim()).filter(Boolean);
  const booksByOption = {};

  if (keys.length) {
    await Promise.all(
      keys.map(async (key) => {
        try {
          const [yesBook, noBook] = await Promise.all([
            getBook(chainMarketId, key, 'YES'),
            getBook(chainMarketId, key, 'NO'),
          ]);
          booksByOption[key] = { YES: yesBook, NO: noBook };
        } catch {
          booksByOption[key] = { YES: { bids: [], asks: [] }, NO: { bids: [], asks: [] } };
        }
      })
    );
  }

  const raw = {};
  for (const key of keys) {
    const yesMid = midFromBookSide(booksByOption[key]?.YES?.bids, booksByOption[key]?.YES?.asks);
    const noMid = midFromBookSide(booksByOption[key]?.NO?.bids, booksByOption[key]?.NO?.asks);
    let p = null;
    if (yesMid != null) p = yesMid;
    else if (noMid != null) p = 1 - noMid;
    if (p == null) {
      const row = (startingPricesRows || []).find((r) => String(r.optionKey) === key);
      const yp = Number(row?.yesPrice);
      if (Number.isFinite(yp) && yp > 0 && yp < 1) p = yp;
    }
    raw[key] = Math.max(0.001, Math.min(0.999, p ?? 1 / Math.max(1, keys.length)));
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const impliedNow = {};
  for (const k of Object.keys(raw)) impliedNow[k] = raw[k] / sum;

  const orders = await Order.find({
    ...withOrderbookContract({ chainMarketId }),
    sizeFilled: { $gt: 0 },
  })
    .sort({ updatedAt: 1 })
    .limit(400)
    .select('optionKey side limitPrice sizeFilled updatedAt createdAt direction isMarketMaker')
    .lean();

  const trades = orders.map((o) => ({
    t: o.updatedAt || o.createdAt,
    optionKey: String(o.optionKey || ''),
    side: o.side,
    price: Number(o.limitPrice) || 0,
    size: Number(o.sizeFilled) || 0,
    direction: o.direction,
    isMarketMaker: !!o.isMarketMaker,
  }));

  return { booksByOption, trades, impliedNow };
}

module.exports = {
  getFees,
  getOrderbookDefaults,
  mergeControl,
  positionKey,
  orderSideBookKey,
  sellBookCacheForKeys,
  computeBuyReservedUsd,
  readVaultBalance,
  reservedCollateralForWallet,
  pendingVaultDebitForWallet,
  openBuyOrderReservedUsd,
  placeOrder,
  cancelOrder,
  getBook,
  expireStaleOrders,
  loadItem,
  assertTradable,
  assertSideNotPaused,
  isOptionSidePaused,
  getOptionPauseFlags,
  runMatch,
  buildSettlementLegs,
  estimateBuyLimitVaultNeedUsd,
  estimateBuyLimitVaultNeedUsdFromBook,
  estimateImmediatelyMatchableSellShares,
  impliedProbabilityByOption,
  getOrderbookMarketActivity,
  getMarketSnapshot,
};
