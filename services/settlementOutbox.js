const { ethers } = require('ethers');
const SettlementOutbox = require('../models/SettlementOutbox');
const Order = require('../models/Order');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const WalletLink = require('../models/WalletLink');
const OrderbookPosition = require('../models/OrderbookPosition');
const { applyOrderbookSettlementsOnChain } = require('../utils/settlementRelay');
const { orderbookContractAddressLower } = require('../utils/orderbookContractScope');
const { applyLegToOrderbookPosition } = require('../utils/orderbookPositionLedger');
const { getResolvedChainMarketIdSet } = require('../utils/resolvedMarkets');

const USDC_DECIMALS = parseInt(process.env.USDC_DECIMALS || '6', 10);
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.SETTLEMENT_OUTBOX_MAX_ATTEMPTS || '25', 10));

function sharesFloatFromWeiString(s) {
  try {
    return parseFloat(ethers.formatUnits(BigInt(s), USDC_DECIMALS));
  } catch {
    return 0;
  }
}

async function refsForChainMarket(chainMarketId, contractLower) {
  const c = contractLower || orderbookContractAddressLower();
  const q = { marketId: chainMarketId };
  if (c) q.contractAddress = c;
  const m = await Match.findOne(q).select('_id').lean();
  if (m) return { match: m._id, poll: null };
  const p = await Poll.findOne(q).select('_id').lean();
  return { match: null, poll: p ? p._id : null };
}

/**
 * Apply confirmed settlement legs to the off-chain position ledger (USDC float units).
 */
async function applyLegsToOrderbookPositions(chainMarketId, legs, contractLower) {
  const refs = await refsForChainMarket(chainMarketId, contractLower);
  const c = contractLower || orderbookContractAddressLower();
  if (!c) {
    console.warn('settlementOutbox: skip position apply — no CONTRACT_ADDRESS');
    return;
  }
  for (const leg of legs) {
    const sh = sharesFloatFromWeiString(leg.sharesDelta);
    const inv = sharesFloatFromWeiString(leg.investedDelta);
    if (Math.abs(sh) < 1e-12 && Math.abs(inv) < 1e-12) continue;

    const addr = String(leg.user).toLowerCase();
    const link = await WalletLink.findOne({ walletAddress: addr }).lean();
    if (!link) {
      console.warn('settlementOutbox: no WalletLink for', addr);
      continue;
    }

    await applyLegToOrderbookPosition({
      chainMarketId,
      walletAddress: addr,
      positionKey: leg.positionKey,
      contractLower: c,
      userId: link.user,
      matchId: refs.match,
      pollId: refs.poll,
      sharesDelta: sh,
      investedDelta: inv,
    });
  }

  await OrderbookPosition.deleteMany({
    chainMarketId,
    shares: { $lte: 1e-9 },
    $or: [
      { contractAddress: c },
      { contractAddress: null },
      { contractAddress: { $exists: false } },
    ],
  });
}

/**
 * Claim one pending job (atomic). Execute on-chain settlement and mark confirmed.
 */
async function processOneSettlementJob() {
  const c = orderbookContractAddressLower();
  if (!c) return { processed: false };

  const job = await SettlementOutbox.findOneAndUpdate(
    {
      status: 'pending',
      attempts: { $lt: MAX_ATTEMPTS },
      contractAddress: c,
    },
    { $set: { status: 'processing', processingStartedAt: new Date() } },
    { sort: { createdAt: 1 }, new: true }
  );

  if (!job) return { processed: false };

  const resolvedIds = await getResolvedChainMarketIdSet();
  if (resolvedIds.has(Number(job.chainMarketId))) {
    await SettlementOutbox.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'cancelled',
          cancelReason: 'market_resolved',
          processingStartedAt: null,
          updatedAt: new Date(),
        },
      }
    );
    return { processed: false, skipped: 'market_resolved' };
  }

  try {
    const txHash = await applyOrderbookSettlementsOnChain(
      job.chainMarketId,
      job.legs,
      job.feeToClaimPool,
      job.feeToJackpotPool || '0'
    );
    const jobContract = job.contractAddress || c;
    const jobFresh = await SettlementOutbox.findById(job._id).select('positionsLedgerApplied').lean();
    if (!jobFresh?.positionsLedgerApplied) {
      await applyLegsToOrderbookPositions(job.chainMarketId, job.legs, jobContract);
    }
    job.status = 'confirmed';
    job.txHash = txHash;
    job.lastError = null;
    job.processingStartedAt = null;
    await job.save();

    const oid = job.orderIds || [];
    for (const id of oid) {
      await Order.findByIdAndUpdate(id, { $push: { settlementTxHashes: txHash } });
    }
    return { processed: true, txHash };
  } catch (err) {
    const msg = err.message || String(err);
    const prevAttempts = job.attempts || 0;
    const nextAttempts = prevAttempts + 1;
    const terminal = nextAttempts >= MAX_ATTEMPTS;
    await SettlementOutbox.updateOne(
      { _id: job._id },
      {
        $set: {
          status: terminal ? 'dead' : 'pending',
          lastError: msg,
          processingStartedAt: null,
        },
        $inc: { attempts: 1 },
      }
    );
    if (terminal) {
      console.error('settlementOutbox: job marked dead after max attempts', {
        id: String(job._id),
        chainMarketId: job.chainMarketId,
        attempts: nextAttempts,
      });
    }
    return { processed: false, error: msg, dead: terminal };
  }
}

async function processSettlementOutboxBatch(max = 5) {
  const results = [];
  for (let i = 0; i < max; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await processOneSettlementJob();
    results.push(r);
    if (!r.processed && !r.error) break;
    if (!r.processed && r.dead) continue;
    if (!r.processed && r.error) break;
  }
  return results;
}

/** Recover jobs stuck in processing (e.g. crash mid-flight). */
async function releaseStaleProcessingJobs(staleMs = 120000) {
  const cutoff = new Date(Date.now() - staleMs);
  await SettlementOutbox.updateMany(
    { status: 'processing', processingStartedAt: { $lt: cutoff } },
    { $set: { status: 'pending', processingStartedAt: null } }
  );
}

module.exports = {
  applyLegsToOrderbookPositions,
  processOneSettlementJob,
  processSettlementOutboxBatch,
  releaseStaleProcessingJobs,
};
