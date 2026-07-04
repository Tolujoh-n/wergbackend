const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Prediction = require('../models/Prediction');
const { readJackpotBalanceOnChain } = require('../utils/jackpotOnChainSync');
const { findRecentJackpotWithdrawals, verifyJackpotWithdrawReceipt } = require('../utils/verifyClaimReceipt');
const { reserveTx, finalizeTx } = require('../utils/processedTx');

/** User-level vault reservation stale after 10 minutes. */
const JACKPOT_CLAIM_LOCK_MS = 10 * 60 * 1000;
/** Per-prediction in-flight claim stale after 10 minutes (no on-chain tx). */
const PREDICTION_CLAIM_LOCK_MS = 10 * 60 * 1000;
const AMOUNT_MATCH_EPS = 0.000002;

function amountsMatch(a, b) {
  return Math.abs(Number(a) - Number(b)) <= AMOUNT_MATCH_EPS;
}

async function finalizeJackpotClaimInDb({ userId, predictionId, withdrawAmount, txHash }) {
  if (txHash && String(txHash).trim()) {
    const { reserved } = await reserveTx('jackpot_withdraw', txHash, {
      user: userId,
      predictionId: String(predictionId),
      amount: withdrawAmount,
    });
    if (!reserved) {
      const fresh = await User.findById(userId);
      const pred = await Prediction.findById(predictionId);
      return {
        alreadyProcessed: true,
        remainingBalance: fresh?.jackpotBalance ?? 0,
        totalWithdrawn: fresh?.jackpotWithdrawn ?? 0,
        prediction: pred,
      };
    }
  }

  const updatedUser = await User.findOneAndUpdate(
    { _id: userId, jackpotBalancePending: { $gte: withdrawAmount } },
    {
      $inc: { jackpotBalancePending: -withdrawAmount, jackpotWithdrawn: withdrawAmount },
      $set: { jackpotWithdrawInProgress: false },
    },
    { new: true }
  );
  if (!updatedUser) {
    const err = new Error(
      'No pending jackpot reservation for this amount. Contact support if USDC was received.'
    );
    err.statusCode = 400;
    throw err;
  }

  const updatedPred = await Prediction.findOneAndUpdate(
    { _id: predictionId, jackpotClaimed: { $ne: true } },
    {
      $set: {
        jackpotClaimed: true,
        jackpotClaimInProgress: false,
        ...(txHash ? { jackpotClaimTxHash: String(txHash).trim() } : {}),
      },
    },
    { new: true }
  );
  if (!updatedPred) {
    const err = new Error('Jackpot already claimed for this prediction');
    err.statusCode = 400;
    throw err;
  }

  if (txHash && String(txHash).trim()) {
    await finalizeTx('jackpot_withdraw', txHash, { 'meta.completed': true });
  }

  return {
    alreadyProcessed: false,
    withdrawn: withdrawAmount,
    remainingBalance: updatedUser.jackpotBalance,
    totalWithdrawn: updatedUser.jackpotWithdrawn,
    prediction: updatedPred,
  };
}

async function tryRecoverStaleJackpotClaims(userId, walletAddress) {
  const inProgress = await Prediction.find({
    user: userId,
    type: 'free',
    jackpotClaimInProgress: true,
    jackpotClaimed: { $ne: true },
    jackpotPayout: { $gt: 0 },
  }).lean();
  if (!inProgress.length || !walletAddress) return false;

  const recent = await findRecentJackpotWithdrawals(walletAddress);
  let recovered = false;

  for (const pred of inProgress) {
    const amt = Number(pred.jackpotPayout) || 0;
    const hit = recent.find((r) => amountsMatch(r.amountUsdc, amt));
    if (!hit) continue;
    try {
      await verifyJackpotWithdrawReceipt({
        txHash: hit.txHash,
        walletAddress,
        amountUsdc: amt,
      });
      await finalizeJackpotClaimInDb({
        userId,
        predictionId: pred._id,
        withdrawAmount: amt,
        txHash: hit.txHash,
      });
      recovered = true;
    } catch (e) {
      console.warn('tryRecoverStaleJackpotClaims:', e?.message || e);
    }
  }
  return recovered;
}

async function rollbackJackpotReservation(userId, predictionId, amount) {
  if (amount > 0) {
    await User.updateOne(
      { _id: userId },
      {
        $inc: { jackpotBalance: amount, jackpotBalancePending: -amount },
        $set: { jackpotWithdrawInProgress: false },
      }
    );
  } else {
    await User.updateOne({ _id: userId }, { $set: { jackpotWithdrawInProgress: false } });
  }
  if (predictionId) {
    await Prediction.updateOne(
      { _id: predictionId },
      { $set: { jackpotClaimInProgress: false, jackpotClaimLockedAt: null } }
    );
  }
}

function lockAgeMs(lockedAt, fallback) {
  const t = lockedAt || fallback;
  if (!t) return Infinity;
  return Date.now() - new Date(t).getTime();
}

/**
 * Clear stale per-prediction jackpot claim locks (abandoned auth / failed tx).
 * Does not clear if a matching on-chain withdraw is found.
 */
async function releaseStaleJackpotPredictionLocks(userId, { predictionId } = {}) {
  const query = {
    user: userId,
    type: 'free',
    jackpotClaimInProgress: true,
    jackpotClaimed: { $ne: true },
  };
  if (predictionId) query._id = predictionId;

  const preds = await Prediction.find(query).lean();
  if (!preds.length) return { released: 0, recovered: false };

  const link = await WalletLink.findOne({ user: userId }).lean();
  let recovered = false;
  if (link?.walletAddress) {
    recovered = await tryRecoverStaleJackpotClaims(userId, link.walletAddress);
    if (recovered) {
      return { released: 0, recovered: true };
    }
  }

  let released = 0;
  for (const pred of preds) {
    const age = lockAgeMs(pred.jackpotClaimLockedAt, pred.updatedAt);
    if (age < PREDICTION_CLAIM_LOCK_MS) continue;

    const amt = Number(pred.jackpotPayout) || 0;
    const user = await User.findById(userId).select('jackpotBalancePending').lean();
    if (user && (user.jackpotBalancePending || 0) >= amt - 0.001 && amt > 0) {
      await rollbackJackpotReservation(userId, pred._id, amt);
    } else {
      await Prediction.updateOne(
        { _id: pred._id },
        { $set: { jackpotClaimInProgress: false, jackpotClaimLockedAt: null } }
      );
    }
    released += 1;
  }
  return { released, recovered: false };
}

async function releaseStaleJackpotReservation(userId) {
  const user = await User.findById(userId).select(
    'jackpotBalance jackpotBalancePending jackpotWithdrawLockedAt jackpotWithdrawInProgress'
  );

  const link = await WalletLink.findOne({ user: userId }).lean();
  if (link?.walletAddress) {
    const recovered = await tryRecoverStaleJackpotClaims(userId, link.walletAddress);
    if (recovered) {
      await releaseStaleJackpotPredictionLocks(userId);
      return { released: true, recovered: true };
    }
  }

  if (user && (user.jackpotBalancePending || 0) > 0) {
    const lockedAt = user.jackpotWithdrawLockedAt;
    if (lockedAt && Date.now() - new Date(lockedAt).getTime() >= JACKPOT_CLAIM_LOCK_MS) {
      if (link?.walletAddress) {
        const onChain = await readJackpotBalanceOnChain(link.walletAddress);
        const dbTotal = (user.jackpotBalance || 0) + (user.jackpotBalancePending || 0);
        if (onChain != null && onChain + 0.02 < dbTotal) {
          await User.updateOne({ _id: userId }, { $set: { jackpotWithdrawInProgress: false } });
          console.warn(
            `jackpot stale lock user ${userId}: on-chain ${onChain} < db ${dbTotal}; skipping pending refund`
          );
        } else {
          const pending = user.jackpotBalancePending;
          await User.updateOne(
            { _id: userId },
            {
              $inc: { jackpotBalance: pending },
              $set: { jackpotBalancePending: 0, jackpotWithdrawInProgress: false },
            }
          );
        }
      } else {
        const pending = user.jackpotBalancePending;
        await User.updateOne(
          { _id: userId },
          {
            $inc: { jackpotBalance: pending },
            $set: { jackpotBalancePending: 0, jackpotWithdrawInProgress: false },
          }
        );
      }
      await Prediction.updateMany(
        { user: userId, jackpotClaimInProgress: true, jackpotClaimed: { $ne: true } },
        { $set: { jackpotClaimInProgress: false, jackpotClaimLockedAt: null } }
      );
    }
  }

  const predResult = await releaseStaleJackpotPredictionLocks(userId);
  return { released: predResult.released > 0, recovered: predResult.recovered };
}

async function releaseAllStaleJackpotLocks(userId, { predictionId } = {}) {
  await releaseStaleJackpotReservation(userId);
  return releaseStaleJackpotPredictionLocks(userId, { predictionId });
}

module.exports = {
  JACKPOT_CLAIM_LOCK_MS,
  PREDICTION_CLAIM_LOCK_MS,
  finalizeJackpotClaimInDb,
  tryRecoverStaleJackpotClaims,
  rollbackJackpotReservation,
  releaseStaleJackpotReservation,
  releaseStaleJackpotPredictionLocks,
  releaseAllStaleJackpotLocks,
};
