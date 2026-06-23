const express = require('express');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const User = require('../models/User');
const Settings = require('../models/Settings');
const Trade = require('../models/Trade');
const WalletLink = require('../models/WalletLink');
const { auth } = require('../middleware/auth');
const { ethers } = require('ethers');
const { payoutToWei, predictionIdToBytes32 } = require('../utils/claimEligibility');
const {
  getClaimSignerAddress,
  signPredictionClaimPayload,
  signOrderbookPositionClaimPayload,
} = require('../utils/claimAuth');
const { assertOrderbookClaimableOnChain } = require('../utils/onChainOrderbook');
const {
  getTicketBalances,
  deductTickets,
  goldenTicketsForBoostAmount,
  awardGoldenTickets,
  getGoldenTicketBoostRate,
} = require('../services/ticketService');
const UserTransaction = require('../models/UserTransaction');
const {
  splitBoostStakeGross,
  applyBoostStakeToEvent,
  validateVerifiedBoostNet,
  txHashRegex,
} = require('../utils/boostFees');

const router = express.Router();

function normalizeWalletAddress(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (!s) return null;
  return s.toLowerCase();
}

async function assertWalletLinkedToUser({ userId, walletAddress }) {
  const addr = normalizeWalletAddress(walletAddress);
  if (!addr) {
    const err = new Error('walletAddress is required');
    err.statusCode = 400;
    throw err;
  }
  const link = await WalletLink.findOne({ walletAddress: addr }).lean();
  if (!link) {
    const err = new Error('Link a wallet to your account');
    err.statusCode = 400;
    throw err;
  }
  if (String(link.user) !== String(userId)) {
    const err = new Error('The wallet address is already associated with another account.');
    err.statusCode = 409;
    throw err;
  }
  return addr;
}

// Helper function to get fees from Settings
async function getFees() {
  const getFee = async (key, defaultValue) => {
    const setting = await Settings.findOne({ key });
    return setting ? (typeof setting.value === 'number' ? setting.value : parseFloat(setting.value) || defaultValue) : defaultValue;
  };
  
  return {
    platformFee: await getFee('platformFee', 10),
    freeJackpotFee: await getFee('freeJackpotFee', 5),
    marketPlatformFee: await getFee('marketPlatformFee', 5),
    boostJackpotFee: await getFee('freeJackpotFee', 5),
  };
}

async function markBoostTransactionCredited({ userId, txHash, action, predictionId, split, netStake }) {
  const pattern = txHashRegex(txHash);
  if (!pattern || !predictionId) return;
  await UserTransaction.updateMany(
    { user: userId, action, txHash: { $regex: pattern } },
    {
      $set: {
        'meta.boostTxCredited': true,
        'meta.predictionCreditedId': String(predictionId),
        'meta.stakeCreditedPredictionId': String(predictionId),
        'meta.creditedNetStake': netStake,
        'meta.creditedJackpotFee': split.jackpotFeeAmount,
        'meta.creditedPlatformFee': split.platformFeeAmount,
      },
    }
  );
}

/**
 * Normalize match outcome to contract canonical form: TeamA, TeamB, or Draw.
 * Accepts team names (e.g. "Poland"), "teamA"/"TeamA"/"TEAMA", etc.
 * @param {string} outcome - Raw outcome from client
 * @param {string} teamA - Match team A name
 * @param {string} teamB - Match team B name
 * @returns {string|null} 'TeamA' | 'TeamB' | 'Draw' or null if invalid
 */
function normalizeMatchOutcome(outcome, teamA, teamB, drawEnabled = true) {
  if (!outcome || typeof outcome !== 'string') return null;
  const raw = String(outcome).trim();
  const lower = raw.toLowerCase();
  const teamALower = (teamA || '').trim().toLowerCase();
  const teamBLower = (teamB || '').trim().toLowerCase();
  if (lower === 'teama' || (teamALower && lower === teamALower)) return 'TeamA';
  if (lower === 'teamb' || (teamBLower && lower === teamBLower)) return 'TeamB';
  if (lower === 'draw') return drawEnabled !== false ? 'Draw' : null;
  return null;
}

/** Admin status only — not scheduled lockedTime. Boost/play until admin locks or resolves. */
function isBoostStakeOpen(item) {
  if (!item) return false;
  if (item.isResolved === true) return false;
  const s = String(item.status || '').toLowerCase().trim();
  if (s === 'locked' || s === 'settled' || s === 'ended') return false;
  return true;
}

function boostVerifyOutcome(prediction, item) {
  let outcome = String(prediction?.outcome || '').trim();
  if (!outcome || !item) return outcome;
  if (prediction.match || item.teamA != null) {
    const normalized = normalizeMatchOutcome(outcome, item.teamA, item.teamB, item.drawEnabled);
    if (normalized) return normalized;
  }
  return outcome;
}

/** Build outcome strings accepted on-chain for tx verification. */
function boostVerifyOutcomeVariants(prediction, item) {
  const primary = boostVerifyOutcome(prediction, item);
  const variants = new Set([primary, String(prediction?.outcome || '').trim()].filter(Boolean));
  if (item?.teamA) variants.add(String(item.teamA).trim());
  if (item?.teamB) variants.add(String(item.teamB).trim());
  variants.add('TeamA');
  variants.add('TeamB');
  variants.add('Draw');
  return [...variants];
}

// Get all predictions for authenticated user
router.get('/user', auth, async (req, res) => {
  try {
    const predictions = await Prediction.find({ user: req.user._id })
      .populate('match', 'teamA teamB date status result isResolved')
      .populate('poll', 'question type status result isResolved')
      .sort({ createdAt: -1 })
      .limit(100);
    
    res.json(predictions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create free prediction (ticket-weighted for jackpot)
router.post('/free', auth, async (req, res) => {
  try {
    const { assertEmailVerified, ensureLegacyEmailVerifiedAt } = require('../services/emailVerificationService');
    const userForEmail = await User.findById(req.user._id).select(
      'email emailVerified emailVerifiedAt phoneVerified freePlayEmailVerification'
    );
    await ensureLegacyEmailVerifiedAt(userForEmail);
    assertEmailVerified(userForEmail);

    const { matchId, pollId, outcome, ticketsToStake } = req.body;
    const ticketsCount = Math.max(1, parseInt(ticketsToStake, 10) || 1);

    if (!matchId && !pollId) {
      return res.status(400).json({ message: 'Either matchId or pollId is required' });
    }

    let item = null;
    if (matchId) item = await Match.findById(matchId);
    else item = await Poll.findById(pollId);
    if (!item) {
      return res.status(404).json({ message: matchId ? 'Match not found' : 'Poll not found' });
    }
    if (item.freePredictionEnabled === false) {
      return res.status(400).json({ message: 'Free prediction is disabled for this event' });
    }
    if (!isBoostStakeOpen(item)) {
      return res.status(400).json({ message: 'Item is locked or ended' });
    }

    const minTickets = Math.max(1, parseInt(item.minFreeTickets, 10) || 1);
    if (ticketsCount < minTickets) {
      return res.status(400).json({
        message: `Minimum ${minTickets} ticket(s) required for this event`,
        minTickets,
      });
    }

    let outcomeToStore = outcome;
    if (matchId && item.teamA != null && item.teamB != null) {
      const normalized = normalizeMatchOutcome(outcome, item.teamA, item.teamB, item.drawEnabled);
      if (!normalized) {
        return res.status(400).json({ message: 'Invalid outcome for match.' });
      }
      outcomeToStore = normalized;
    }

    const query = { user: req.user._id, type: 'free' };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;

    const existingPrediction = await Prediction.findOne(query);
    if (existingPrediction) {
      if (item.status === 'upcoming' || item.status === 'active') {
        const sameOutcome = String(existingPrediction.outcome) === String(outcomeToStore);
        if (sameOutcome) {
          return res.status(409).json({
            message: 'You already have a free prediction on this pick. Use Add Tickets to stake more.',
            code: 'FREE_PREDICTION_EXISTS',
            prediction: existingPrediction,
          });
        }
        return res.status(400).json({
          message: 'You can only add tickets to your current pick. Outcome cannot be changed.',
          code: 'FREE_OUTCOME_LOCKED',
        });
      }
      return res.status(400).json({ message: 'You already predicted this item' });
    }

    const balances = await getTicketBalances(req.user._id);
    if (balances.totalSpendable < ticketsCount) {
      return res.status(400).json({
        message: 'Insufficient tickets',
        required: ticketsCount,
        ...balances,
      });
    }

    await deductTickets(req.user._id, ticketsCount);

    const prediction = new Prediction({
      user: req.user._id,
      match: matchId,
      poll: pollId,
      type: 'free',
      outcome: outcomeToStore,
      ticketsStaked: ticketsCount,
    });
    await prediction.save();

    const user = await User.findById(req.user._id);
    user.totalPredictions += 1;
    const { recordFreePredictionStreak } = require('../services/engagementStreakService');
    recordFreePredictionStreak(user);
    await user.save();

    const remaining = await getTicketBalances(req.user._id);
    res.status(201).json({
      prediction,
      ticketsStaked: ticketsCount,
      remaining,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, details: error.details });
  }
});

// Add tickets to an existing free prediction (same outcome only)
router.post('/free/:predictionId/add-tickets', auth, async (req, res) => {
  try {
    const { assertEmailVerified, ensureLegacyEmailVerifiedAt } = require('../services/emailVerificationService');
    const userForEmail = await User.findById(req.user._id).select(
      'email emailVerified emailVerifiedAt phoneVerified freePlayEmailVerification'
    );
    await ensureLegacyEmailVerifiedAt(userForEmail);
    assertEmailVerified(userForEmail);

    const ticketsToAdd = Math.max(1, parseInt(req.body.ticketsToAdd, 10) || 0);
    const prediction = await Prediction.findById(req.params.predictionId)
      .populate('match')
      .populate('poll');

    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }
    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    if (prediction.type !== 'free') {
      return res.status(400).json({ message: 'This endpoint is only for free predictions' });
    }

    const item = prediction.match || prediction.poll;
    if (!item) {
      return res.status(400).json({ message: 'Event not found' });
    }
    if (item.freePredictionEnabled === false) {
      return res.status(400).json({ message: 'Free prediction is disabled for this event' });
    }
    if (!isBoostStakeOpen(item)) {
      return res.status(400).json({ message: 'Predictions are locked or ended' });
    }

    const minTickets = Math.max(1, parseInt(item.minFreeTickets, 10) || 1);
    if (ticketsToAdd < minTickets) {
      return res.status(400).json({
        message: `Minimum ${minTickets} ticket(s) required per add`,
        minTickets,
      });
    }

    const balances = await getTicketBalances(req.user._id);
    if (balances.totalSpendable < ticketsToAdd) {
      return res.status(400).json({
        message: 'Insufficient tickets',
        required: ticketsToAdd,
        ...balances,
      });
    }

    await deductTickets(req.user._id, ticketsToAdd);
    prediction.ticketsStaked = (prediction.ticketsStaked || 1) + ticketsToAdd;
    prediction.updatedAt = new Date();
    await prediction.save();

    const remaining = await getTicketBalances(req.user._id);
    res.json({
      prediction,
      ticketsAdded: ticketsToAdd,
      remaining,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message, details: error.details });
  }
});

// Create boost prediction
router.post('/boost', auth, async (req, res) => {
  try {
    const { matchId, pollId, outcome, amount } = req.body;

    if (!matchId && !pollId) {
      return res.status(400).json({ message: 'Either matchId or pollId is required' });
    }

    let item = null;
    if (matchId) {
      item = await Match.findById(matchId);
      if (!item) {
        return res.status(404).json({ message: 'Match not found' });
      }
    } else {
      item = await Poll.findById(pollId);
      if (!item) {
        return res.status(404).json({ message: 'Poll not found' });
      }
    }

    if (item.status === 'locked' || item.status === 'settled' || item.status === 'ended') {
      return res.status(400).json({ message: 'Item is locked or ended' });
    }
    if (item.isResolved) {
      return res.status(400).json({ message: 'Item is resolved' });
    }

    let outcomeToStore = outcome;
    if (matchId && item.teamA != null && item.teamB != null) {
      const normalized = normalizeMatchOutcome(outcome, item.teamA, item.teamB, item.drawEnabled);
      if (!normalized) {
        return res.status(400).json({ message: 'Invalid outcome for match.' });
      }
      outcomeToStore = normalized;
    }

    const query = {
      user: req.user._id,
      type: 'boost',
      outcome: outcomeToStore,
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;

    const linkedWallet = await assertWalletLinkedToUser({
      userId: req.user._id,
      walletAddress: req.body.walletAddress,
    });

    const { txHash } = req.body || {};
    let verifiedStake = null;
    if (item.marketId != null) {
      if (!txHash || !String(txHash).trim()) {
        return res.status(400).json({
          message: 'On-chain boost stake required: call stakeBoost on the contract first and pass txHash',
        });
      }
      const { verifyBoostStakeTx } = require('../utils/verifyBoostStake');
      verifiedStake = await verifyBoostStakeTx({
        txHash: String(txHash).trim(),
        marketId: item.marketId,
        walletAddress: linkedWallet,
        outcome: outcomeToStore,
        outcomes: boostVerifyOutcomeVariants({ outcome: outcomeToStore }, item),
      });
      if (!verifiedStake.ok) {
        return res.status(400).json({ message: verifiedStake.reason || 'Invalid boost stake transaction' });
      }

      const txPattern = txHashRegex(txHash);
      if (txPattern) {
        const credited = await UserTransaction.findOne({
          user: req.user._id,
          action: 'boost_stake',
          txHash: { $regex: txPattern },
          'meta.boostTxCredited': true,
        }).lean();
        if (credited?.meta?.predictionCreditedId) {
          const existing = await Prediction.findById(credited.meta.predictionCreditedId);
          if (existing) {
            return res.status(201).json({
              prediction: existing,
              goldenTicketsAwarded: 0,
              alreadyCredited: true,
            });
          }
        }
      }
    }

    const existingBoostPrediction = await Prediction.findOne(query);

    if (existingBoostPrediction) {
      return res.status(409).json({
        message: 'You already have a boost on this outcome. Use Add Stake to increase your position.',
        code: 'BOOST_OUTCOME_EXISTS',
        prediction: existingBoostPrediction,
      });
    }

    const fees = await getFees();
    const stakeAmount = parseFloat(amount);
    const split = splitBoostStakeGross(stakeAmount, fees);

    if (verifiedStake?.ok && Number.isFinite(verifiedStake.netStakeUsdc)) {
      const netCheck = validateVerifiedBoostNet(split, verifiedStake.netStakeUsdc);
      if (!netCheck.ok) {
        return res.status(400).json({ message: netCheck.reason });
      }
    }

    const rate = await getGoldenTicketBoostRate();
    const goldenAward = goldenTicketsForBoostAmount(rate, stakeAmount);
    if (goldenAward > 0) await awardGoldenTickets(req.user._id, goldenAward);

    const stakeForDb = split.netStakeAmount;

    const prediction = new Prediction({
      user: req.user._id,
      match: matchId,
      poll: pollId,
      type: 'boost',
      outcome: outcomeToStore,
      walletAddress: linkedWallet,
      amount: stakeForDb,
      totalStake: stakeForDb,
    });

    await prediction.save();

    applyBoostStakeToEvent(item, split);
    await item.save();

    const user = await User.findById(req.user._id);
    user.totalPredictions += 1;
    const { recordBoostPredictionStreak } = require('../services/engagementStreakService');
    recordBoostPredictionStreak(user);
    await user.save();

    if (txHash && String(txHash).trim()) {
      await markBoostTransactionCredited({
        userId: req.user._id,
        txHash: String(txHash).trim(),
        action: 'boost_stake',
        predictionId: prediction._id,
        split,
        netStake: stakeForDb,
      });
    }

    res.status(201).json({ prediction, goldenTicketsAwarded: goldenAward });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Boost pool breakdown (public) — used for proportional potential-win previews
router.get('/match/:matchId/boost-stats', async (req, res) => {
  try {
    const { getBoostPoolStats } = require('../utils/boostPayout');
    const stats = await getBoostPoolStats({ matchId: req.params.matchId });
    if (!stats) return res.status(404).json({ message: 'Match not found' });
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/poll/:pollId/boost-stats', async (req, res) => {
  try {
    const { getBoostPoolStats } = require('../utils/boostPayout');
    const stats = await getBoostPoolStats({ pollId: req.params.pollId });
    if (!stats) return res.status(404).json({ message: 'Poll not found' });
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/match/:matchId/free-jackpot-stats', async (req, res) => {
  try {
    const { getFreeJackpotStats } = require('../utils/jackpotDistribution');
    const stats = await getFreeJackpotStats({ matchId: req.params.matchId });
    if (!stats) return res.status(404).json({ message: 'Match not found' });
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/poll/:pollId/free-jackpot-stats', async (req, res) => {
  try {
    const { getFreeJackpotStats } = require('../utils/jackpotDistribution');
    const stats = await getFreeJackpotStats({ pollId: req.params.pollId });
    if (!stats) return res.status(404).json({ message: 'Poll not found' });
    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user prediction for a match (by type)
router.get('/match/:matchId/user', auth, async (req, res) => {
  try {
    const { type } = req.query;
    const query = {
      user: req.user._id,
      match: req.params.matchId,
    };
    
    // Filter by type if provided
    if (type) {
      query.type = type;
    }
    
    // For market and boost types, return all predictions (one per option/outcome)
    if (type === 'market' || type === 'boost') {
      const predictions = await Prediction.find(query)
        .populate('match', 'teamA teamB date status result isResolved');
      return res.json(predictions);
    }
    
    const prediction = await Prediction.findOne(query)
      .populate('match', 'teamA teamB date status result isResolved');
    
    // Return null instead of 404 for better frontend handling
    if (!prediction) {
      return res.json(null);
    }
    res.json(prediction);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user prediction for a poll (by type)
router.get('/poll/:pollId/user', auth, async (req, res) => {
  try {
    const { type } = req.query;
    const query = {
      user: req.user._id,
      poll: req.params.pollId,
    };
    
    // Filter by type if provided
    if (type) {
      query.type = type;
    }
    
    // For market and boost types, return all predictions (one per option/outcome)
    if (type === 'market' || type === 'boost') {
      const predictions = await Prediction.find(query)
        .populate('poll', 'question type status result isResolved');
      return res.json(predictions);
    }
    
    const prediction = await Prediction.findOne(query)
      .populate('poll', 'question type status result isResolved');
    
    // Return null instead of 404 for better frontend handling
    if (!prediction) {
      return res.json(null);
    }
    res.json(prediction);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update free/boost prediction (only if item is upcoming)
router.put('/:predictionId', auth, async (req, res) => {
  try {
    const { outcome } = req.body;
    const prediction = await Prediction.findById(req.params.predictionId)
      .populate('match')
      .populate('poll');
    
    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }
    
    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    // Check if item is still upcoming
    const item = prediction.match || prediction.poll;
    if (!item || !isBoostStakeOpen(item)) {
      return res.status(400).json({ message: 'Cannot update prediction. Item is not open' });
    }

    if (prediction.type === 'free') {
      return res.status(400).json({
        message: 'Cannot change free prediction outcome. Add tickets to your current pick instead.',
      });
    }
    if (prediction.type === 'boost') {
      return res.status(400).json({
        message: 'Cannot change boost outcome. Boost another option or add stake to this position.',
      });
    }
    
    // Normalize outcome for matches to contract canonical form (TeamA, TeamB, Draw)
    let outcomeToStore = outcome;
    if (prediction.match && item.teamA != null && item.teamB != null) {
      const normalized = normalizeMatchOutcome(outcome, item.teamA, item.teamB);
      if (!normalized) {
        return res.status(400).json({ message: 'Invalid outcome for match. Use Team A, Team B, or Draw.' });
      }
      outcomeToStore = normalized;
    }
    
    // For boost predictions, preserve the amount (totalStake) when updating outcome
    const oldOutcome = prediction.outcome;
    prediction.outcome = outcomeToStore;
    prediction.updatedAt = new Date();
    
    // For boost predictions, the amount is automatically preserved
    // The boost pool doesn't need to change since we're just changing the outcome
    // The total stake amount stays the same, just mapped to a different outcome
    if (prediction.type === 'boost') {
      // Ensure totalStake is set if it wasn't before
      if (!prediction.totalStake && prediction.amount) {
        prediction.totalStake = prediction.amount;
      }
      // The amount field should reflect the totalStake
      prediction.amount = prediction.totalStake || prediction.amount;
    }
    
    await prediction.save();
    
    res.json(prediction);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Recover boost txs that succeeded on-chain but failed backend save (initial stake + add-stake)
router.post('/boost/reconcile-pending', auth, async (req, res) => {
  try {
    const linkedWallet = await assertWalletLinkedToUser({
      userId: req.user._id,
      walletAddress: req.body.walletAddress,
    });
    const pending = await UserTransaction.find({
      user: req.user._id,
      action: { $in: ['boost_stake', 'boost_add_stake'] },
      txHash: { $exists: true, $nin: [null, ''] },
      'meta.boostTxCredited': { $ne: true },
    })
      .sort({ createdAt: -1 })
      .limit(20);

    const { verifyBoostStakeTx } = require('../utils/verifyBoostStake');
    const fees = await getFees();
    let reconciled = 0;

    for (const row of pending) {
      const itemId = row.itemId;
      if (!itemId || !row.txHash) continue;

      let item = await Match.findById(itemId);
      let isMatch = Boolean(item);
      if (!item) {
        item = await Poll.findById(itemId);
        isMatch = false;
      }
      if (!item?.marketId) continue;

      const verified = await verifyBoostStakeTx({
        txHash: row.txHash,
        marketId: item.marketId,
        walletAddress: linkedWallet,
        outcome: row.meta?.outcome ? String(row.meta.outcome).trim() : '',
        outcomes: boostVerifyOutcomeVariants(
          { outcome: row.meta?.outcome ? String(row.meta.outcome).trim() : '' },
          item
        ),
      });
      if (!verified.ok) continue;

      const stakeAmount = Number(row.amount) || 0;
      if (stakeAmount <= 0) continue;

      const split = splitBoostStakeGross(stakeAmount, fees);
      if (verified.ok && Number.isFinite(verified.netStakeUsdc)) {
        const netCheck = validateVerifiedBoostNet(split, verified.netStakeUsdc);
        if (!netCheck.ok) continue;
      }
      const addNet = split.netStakeAmount;

      const outcomeHint = row.meta?.outcome ? String(row.meta.outcome).trim() : '';
      const predQuery = {
        user: req.user._id,
        type: 'boost',
        $or: [{ match: itemId }, { poll: itemId }],
      };

      let prediction = outcomeHint
        ? await Prediction.findOne({ ...predQuery, outcome: outcomeHint })
        : null;
      if (!prediction) prediction = await Prediction.findOne(predQuery);

      if (row.action === 'boost_stake') {
        if (!prediction) {
          if (!outcomeHint) continue;
          let outcomeToStore = outcomeHint;
          if (isMatch && item.teamA != null && item.teamB != null) {
            const normalized = normalizeMatchOutcome(outcomeHint, item.teamA, item.teamB, item.drawEnabled);
            if (normalized) outcomeToStore = normalized;
          }
          prediction = new Prediction({
            user: req.user._id,
            match: isMatch ? itemId : undefined,
            poll: isMatch ? undefined : itemId,
            type: 'boost',
            outcome: outcomeToStore,
            walletAddress: linkedWallet,
            amount: addNet,
            totalStake: addNet,
          });
          await prediction.save();
          const user = await User.findById(req.user._id);
          user.totalPredictions += 1;
          await user.save();
        }
      } else if (row.action === 'boost_add_stake') {
        if (!prediction) continue;
        prediction.totalStake = (prediction.totalStake || prediction.amount || 0) + addNet;
        prediction.amount = prediction.totalStake;
        if (!prediction.walletAddress) prediction.walletAddress = linkedWallet;
        await prediction.save();
      } else {
        continue;
      }

      applyBoostStakeToEvent(item, split);
      await item.save();

      await markBoostTransactionCredited({
        userId: req.user._id,
        txHash: row.txHash,
        action: row.action,
        predictionId: prediction._id,
        split,
        netStake: addNet,
      });
      reconciled += 1;
    }

    res.json({ reconciled });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Boost: Add or withdraw stake
router.post('/boost/:predictionId/stake', auth, async (req, res) => {
  try {
    const linkedWallet = await assertWalletLinkedToUser({
      userId: req.user._id,
      walletAddress: req.body.walletAddress,
    });
    const { action, amount, txHash } = req.body; // action: 'add' or 'withdraw'

    if (!['add', 'withdraw'].includes(action)) {
      return res.status(400).json({ message: 'Action must be "add" or "withdraw"' });
    }
    
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }
    
    const prediction = await Prediction.findById(req.params.predictionId)
      .populate('match')
      .populate('poll');
    
    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }
    
    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    if (prediction.type !== 'boost') {
      return res.status(400).json({ message: 'This endpoint is only for boost predictions' });
    }

    // Ensure stake modifications are performed by the same wallet used for this boost position.
    if (prediction.walletAddress && normalizeWalletAddress(prediction.walletAddress) !== linkedWallet) {
      return res.status(403).json({ message: 'Connect the wallet used for this boost position' });
    }
    if (!prediction.walletAddress) {
      prediction.walletAddress = linkedWallet;
    }
    
    // Check if item is still upcoming
    const item = prediction.match || prediction.poll;
    if (!item || !isBoostStakeOpen(item)) {
      return res.status(400).json({ message: 'Cannot modify stake. Item is not open for predictions' });
    }
    
    const stakeAmount = parseFloat(amount);
    
    // Get fees from settings
    const fees = await getFees();
    let goldenTicketsAwarded = 0;
    let verifiedAdd = null;
    let addStakeSplit = null;
    let addNetStake = null;
    
    if (action === 'add') {
      const txKey = txHash ? String(txHash).trim().toLowerCase() : '';
      if (txKey) {
        const alreadyCredited = await UserTransaction.findOne({
          user: req.user._id,
          action: 'boost_add_stake',
          txHash: { $regex: txHashRegex(txHash) },
          'meta.boostTxCredited': true,
        });
        if (alreadyCredited) {
          return res.json({ ...prediction.toObject(), goldenTicketsAwarded: 0, alreadyCredited: true });
        }
      }
      if (item.marketId != null) {
        if (!txHash || !String(txHash).trim()) {
          return res.status(400).json({
            message: 'On-chain addBoostStake required: pass txHash from the contract transaction',
          });
        }
        const { verifyBoostStakeTx } = require('../utils/verifyBoostStake');
        const outcomeForVerify = boostVerifyOutcome(prediction, item);
        verifiedAdd = await verifyBoostStakeTx({
          txHash: String(txHash).trim(),
          marketId: item.marketId,
          walletAddress: linkedWallet,
          outcome: outcomeForVerify,
          outcomes: boostVerifyOutcomeVariants(prediction, item),
        });
        if (!verifiedAdd.ok) {
          return res.status(400).json({ message: verifiedAdd.reason || 'Invalid boost stake transaction' });
        }
      }

      addStakeSplit = splitBoostStakeGross(stakeAmount, fees);
      if (verifiedAdd?.ok && Number.isFinite(verifiedAdd.netStakeUsdc)) {
        const netCheck = validateVerifiedBoostNet(addStakeSplit, verifiedAdd.netStakeUsdc);
        if (!netCheck.ok) {
          return res.status(400).json({ message: netCheck.reason });
        }
      }

      const rate = await getGoldenTicketBoostRate();
      goldenTicketsAwarded = goldenTicketsForBoostAmount(rate, stakeAmount);
      if (goldenTicketsAwarded > 0) await awardGoldenTickets(req.user._id, goldenTicketsAwarded);

      addNetStake = addStakeSplit.netStakeAmount;

      prediction.totalStake = (prediction.totalStake || prediction.amount || 0) + addNetStake;
      prediction.amount = prediction.totalStake;

      applyBoostStakeToEvent(item, addStakeSplit);
    } else if (action === 'withdraw') {
      if (item.marketId != null) {
        if (!txHash || !String(txHash).trim()) {
          return res.status(400).json({
            message: 'On-chain withdrawBoostStake required: pass txHash from the contract transaction',
          });
        }
        const { verifyBoostWithdrawTx } = require('../utils/verifyBoostStake');
        const verified = await verifyBoostWithdrawTx({
          txHash: String(txHash).trim(),
          marketId: item.marketId,
          walletAddress: linkedWallet,
        });
        if (!verified.ok) {
          return res.status(400).json({ message: verified.reason || 'Invalid boost withdraw transaction' });
        }
      }
      const currentStake = prediction.totalStake || prediction.amount || 0;
      if (stakeAmount > currentStake) {
        return res.status(400).json({ message: 'Cannot withdraw more than current stake' });
      }
      
      // For withdrawal, reduce from net stake (no fees on withdrawal)
      prediction.totalStake = currentStake - stakeAmount;
      prediction.amount = prediction.totalStake;
      
      // Update boost pool (reduce net amount)
      if (prediction.match) {
        item.boostPool = Math.max(0, (item.boostPool || 0) - stakeAmount);
      } else {
        item.boostPool = Math.max(0, (item.boostPool || 0) - stakeAmount);
      }
    }
    
    prediction.updatedAt = new Date();
    await prediction.save();
    await item.save();

    if (txHash && action === 'add' && addStakeSplit) {
      await markBoostTransactionCredited({
        userId: req.user._id,
        txHash,
        action: 'boost_add_stake',
        predictionId: prediction._id,
        split: addStakeSplit,
        netStake: addNetStake ?? addStakeSplit.netStakeAmount,
      });
    } else if (txHash && action === 'withdraw') {
      const pattern = txHashRegex(txHash);
      if (pattern) {
        await UserTransaction.updateMany(
          { user: req.user._id, action: 'boost_withdraw_stake', txHash: { $regex: pattern } },
          { $set: { 'meta.stakeCreditedPredictionId': String(prediction._id) } }
        );
      }
    }

    res.json({
      ...prediction.toObject(),
      goldenTicketsAwarded,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Market: Buy shares
router.post('/market/buy', auth, async (req, res) => {
  try {
    const linkedWallet = await assertWalletLinkedToUser({
      userId: req.user._id,
      walletAddress: req.body.walletAddress,
    });
    let { matchId, pollId, outcome, amount } = req.body;
    
    if (!matchId && !pollId) {
      return res.status(400).json({ message: 'Either matchId or pollId is required' });
    }
    
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ message: 'Invalid amount' });
    }
    
    let item = null;
    if (matchId) {
      item = await Match.findById(matchId);
      if (!item) {
        return res.status(404).json({ message: 'Match not found' });
      }
      // Accept team names or TeamA/TeamB/Draw (any case) and normalize to contract form
      const normalizedMatchOutcome = normalizeMatchOutcome(outcome, item.teamA, item.teamB);
      if (!normalizedMatchOutcome) {
        return res.status(400).json({ message: 'Invalid outcome for match. Use Team A, Team B, or Draw.' });
      }
      outcome = normalizedMatchOutcome; // use canonical form for rest of handler
    } else {
      item = await Poll.findById(pollId);
      if (!item) {
        return res.status(404).json({ message: 'Poll not found' });
      }
      // For option-based polls, validate outcome is one of the option texts
      if (item.optionType === 'options') {
        if (!item.options || !item.options.some(opt => opt.text === outcome)) {
          return res.status(400).json({ message: 'Invalid outcome for poll option' });
        }
      } else {
        // Normal Yes/No poll
        if (!['yes', 'no', 'YES', 'NO'].includes(outcome)) {
          return res.status(400).json({ message: 'Invalid outcome for poll' });
        }
      }
    }
    
    if (item.status === 'locked' || item.status === 'completed' || item.status === 'settled' || item.isResolved) {
      return res.status(400).json({ message: 'Item is locked or resolved' });
    }
    
    if (!item.marketInitialized) {
      return res.status(400).json({ message: 'Market not initialized' });
    }
    
    const investAmount = parseFloat(amount);
    
    // Get fees from settings
    const fees = await getFees();
    
    // Calculate fees for market buy
    const marketPlatformFeeAmount = (investAmount * fees.marketPlatformFee) / 100;
    const freeJackpotFeeAmount = (investAmount * fees.freeJackpotFee) / 100;
    const netInvestAmount = investAmount - marketPlatformFeeAmount - freeJackpotFeeAmount;
    
    let normalizedOutcome = outcome;
    
    // Calculate shares based on current liquidity (simplified AMM)
    // Use net amount for liquidity calculation
    let shares = 0;
    let totalLiquidity = 0;
    let optionLiquidity = 0;
    
    if (matchId) {
      normalizedOutcome = outcome.toUpperCase();
      totalLiquidity = (item.marketTeamALiquidity || 0) + (item.marketTeamBLiquidity || 0) + (item.marketDrawLiquidity || 0);
      if (normalizedOutcome === 'TEAMA') {
        optionLiquidity = item.marketTeamALiquidity || 0;
      } else if (normalizedOutcome === 'TEAMB') {
        optionLiquidity = item.marketTeamBLiquidity || 0;
      } else if (normalizedOutcome === 'DRAW') {
        optionLiquidity = item.marketDrawLiquidity || 0;
      }
    } else {
      // Handle poll
      if (item.optionType === 'options') {
        // For option-based polls, use the option text as outcome
        normalizedOutcome = outcome;
        // Calculate total liquidity from all options
        totalLiquidity = item.options.reduce((sum, opt) => sum + (opt.liquidity || 0), 0);
        // Find the selected option
        const selectedOption = item.options.find(opt => opt.text === outcome);
        if (selectedOption) {
          optionLiquidity = selectedOption.liquidity || 0;
        }
      } else {
        // Normal Yes/No poll
        normalizedOutcome = outcome.toUpperCase();
        totalLiquidity = (item.marketYesLiquidity || 0) + (item.marketNoLiquidity || 0);
        if (normalizedOutcome === 'YES') {
          optionLiquidity = item.marketYesLiquidity || 0;
        } else if (normalizedOutcome === 'NO') {
          optionLiquidity = item.marketNoLiquidity || 0;
        }
      }
    }
    
    if (totalLiquidity === 0) {
      return res.status(400).json({ message: 'Market not initialized' });
    }
    
    // Fixed-Sum AMM Logic:
    // Price per share = outcomeLiquidity / totalLiquidity (rounded to 4 decimals)
    // When buying X ETH: shares = X / currentPrice
    // After buying: newLiquidity = oldLiquidity + X, newTotal = oldTotal + X
    
    // Calculate current price BEFORE adding investment (rounded to 4 decimals)
    const currentPrice = totalLiquidity > 0 
      ? parseFloat((optionLiquidity / totalLiquidity).toFixed(4)) 
      : 0;
    
    // Calculate shares: shares = investment / currentPrice
    if (currentPrice === 0) {
      // If price is 0, market not initialized properly
      return res.status(400).json({ message: 'Cannot calculate shares: price is 0' });
    }
    shares = parseFloat((netInvestAmount / currentPrice).toFixed(4));
    
    // Calculate new liquidity after adding investment
    const newOptionLiquidity = optionLiquidity + netInvestAmount;
    const newTotalLiquidity = totalLiquidity + netInvestAmount;
    
    // Calculate new price after investment (should be higher, rounded to 4 decimals)
    const newPrice = newTotalLiquidity > 0 
      ? parseFloat((newOptionLiquidity / newTotalLiquidity).toFixed(4)) 
      : 0;
    
    // Find or create prediction FOR THIS SPECIFIC OPTION (isolated per option)
    const query = {
      user: req.user._id,
      type: 'market',
      outcome: normalizedOutcome, // Include outcome in query to isolate per option
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;
    
    let prediction = await Prediction.findOne(query);
    
    if (prediction) {
      // Update existing prediction for this option
      prediction.shares = (prediction.shares || 0) + shares;
      prediction.totalInvested = (prediction.totalInvested || 0) + netInvestAmount;
      if (!prediction.walletAddress) prediction.walletAddress = linkedWallet;
    } else {
      // Create new prediction for this option
      prediction = new Prediction({
        user: req.user._id,
        match: matchId,
        poll: pollId,
        type: 'market',
        outcome: normalizedOutcome,
        walletAddress: linkedWallet,
        shares: shares,
        totalInvested: netInvestAmount,
      });
    }
    
    // Update market liquidity with net amount (AMM: buying increases option's pool)
    // This automatically increases the price because optionLiquidity/totalLiquidity increases
    if (matchId) {
      if (normalizedOutcome === 'TEAMA') {
        item.marketTeamALiquidity = newOptionLiquidity; // Use new liquidity (old + investment)
        item.marketTeamAShares = (item.marketTeamAShares || 0) + shares;
      } else if (normalizedOutcome === 'TEAMB') {
        item.marketTeamBLiquidity = newOptionLiquidity;
        item.marketTeamBShares = (item.marketTeamBShares || 0) + shares;
      } else if (normalizedOutcome === 'DRAW') {
        item.marketDrawLiquidity = newOptionLiquidity;
        item.marketDrawShares = (item.marketDrawShares || 0) + shares;
      }
      // Update fees and jackpot pools
      item.freeJackpotPool = (item.freeJackpotPool || 0) + freeJackpotFeeAmount;
      item.platformFees = (item.platformFees || 0) + marketPlatformFeeAmount;
    } else {
      // Handle poll
      if (item.optionType === 'options') {
        // Update the specific option
        const selectedOption = item.options.find(opt => opt.text === outcome);
        if (selectedOption) {
          selectedOption.liquidity = newOptionLiquidity; // Use new liquidity
          selectedOption.shares = (selectedOption.shares || 0) + shares;
        }
      } else {
        // Normal Yes/No poll
        if (normalizedOutcome === 'YES') {
          item.marketYesLiquidity = newOptionLiquidity;
          item.marketYesShares = (item.marketYesShares || 0) + shares;
        } else if (normalizedOutcome === 'NO') {
          item.marketNoLiquidity = newOptionLiquidity;
          item.marketNoShares = (item.marketNoShares || 0) + shares;
        }
      }
      // Update fees and jackpot pools for polls
      item.freeJackpotPool = (item.freeJackpotPool || 0) + freeJackpotFeeAmount;
      item.platformFees = (item.platformFees || 0) + marketPlatformFeeAmount;
    }
    
    prediction.updatedAt = new Date();
    await prediction.save();
    await item.save();
    
    // Reload item to get fresh data with updated prices
    const updatedItem = matchId 
      ? await Match.findById(matchId)
      : await Poll.findById(pollId);
    
    // Calculate updated prices for response
    let updatedPrices = {};
    let updatedTotalLiquidity = 0;
    
    if (matchId) {
      updatedTotalLiquidity = (updatedItem.marketTeamALiquidity || 0) + 
                              (updatedItem.marketTeamBLiquidity || 0) + 
                              (updatedItem.marketDrawLiquidity || 0);
      // Round all prices to 4 decimal places
      updatedPrices.teamA = updatedTotalLiquidity > 0 
        ? parseFloat(((updatedItem.marketTeamALiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
        : parseFloat((0.333).toFixed(4));
      updatedPrices.teamB = updatedTotalLiquidity > 0 
        ? parseFloat(((updatedItem.marketTeamBLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
        : parseFloat((0.333).toFixed(4));
      updatedPrices.draw = updatedTotalLiquidity > 0 
        ? parseFloat(((updatedItem.marketDrawLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
        : parseFloat((0.333).toFixed(4));
    } else {
      if (updatedItem.optionType === 'options') {
        updatedTotalLiquidity = updatedItem.options.reduce((sum, opt) => sum + (opt.liquidity || 0), 0);
        updatedItem.options.forEach(opt => {
          const defaultPrice = 1 / updatedItem.options.length;
          updatedPrices[opt.text] = updatedTotalLiquidity > 0 
            ? parseFloat(((opt.liquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
            : parseFloat(defaultPrice.toFixed(4));
        });
      } else {
        updatedTotalLiquidity = (updatedItem.marketYesLiquidity || 0) + (updatedItem.marketNoLiquidity || 0);
        updatedPrices.yes = updatedTotalLiquidity > 0 
          ? parseFloat(((updatedItem.marketYesLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
          : parseFloat((0.5).toFixed(4));
        updatedPrices.no = updatedTotalLiquidity > 0 
          ? parseFloat(((updatedItem.marketNoLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
          : parseFloat((0.5).toFixed(4));
      }
    }
    
    // Verify prices sum to 1.0
    const priceSum = Object.values(updatedPrices).reduce((sum, price) => sum + price, 0);
    if (Math.abs(priceSum - 1.0) > 0.01) {
      console.warn('Prices do not sum to 1.0 after buy:', priceSum, updatedPrices);
    }

    // Create trade record for this buy transaction with full post-trade price snapshot.
    // This is required for correct charting because every trade changes ALL outcome prices.
    const trade = new Trade({
      user: req.user._id,
      match: matchId,
      poll: pollId,
      type: 'buy',
      outcome: normalizedOutcome,
      amount: netInvestAmount,
      shares: shares,
      price: newPrice, // Price for the traded outcome after purchase
      pricesSnapshot: updatedPrices, // Full post-trade prices
    });
    await trade.save();
    
    res.json({
      prediction,
      updatedItem,
      updatedPrices,
      newPrice,
      totalLiquidity: updatedTotalLiquidity,
      message: 'Buy successful. All prices updated.'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Market: Sell shares
router.post('/market/sell', auth, async (req, res) => {
  try {
    const { matchId, pollId, outcome, shares: sharesToSell } = req.body;
    
    if (!matchId && !pollId) {
      return res.status(400).json({ message: 'Either matchId or pollId is required' });
    }
    
    if (!outcome) {
      return res.status(400).json({ message: 'Outcome is required for selling' });
    }
    
    // Get item first to check optionType
    let item = null;
    if (matchId) {
      item = await Match.findById(matchId);
      if (!item) {
        return res.status(404).json({ message: 'Match not found' });
      }
    } else {
      item = await Poll.findById(pollId);
      if (!item) {
        return res.status(404).json({ message: 'Poll not found' });
      }
    }
    
    // Normalize outcome BEFORE searching for prediction (must match how it was stored during buy)
    let normalizedOutcome = outcome;
    if (matchId) {
      // For matches: use same canonical form as buy (TeamA, TeamB, Draw)
      const canonical = normalizeMatchOutcome(outcome, item.teamA, item.teamB);
      if (!canonical) {
        return res.status(400).json({ message: 'Invalid outcome for match. Use Team A, Team B, or Draw.' });
      }
      normalizedOutcome = canonical;
    } else {
      // For polls
      if (item.optionType === 'options') {
        // For option-based polls, keep as-is (exact text match, same as buy route)
        normalizedOutcome = outcome;
      } else {
        // Normal Yes/No poll: normalize to YES/NO (same as buy route)
        normalizedOutcome = outcome.toUpperCase();
      }
    }
    
    // Find prediction FOR THIS SPECIFIC OPTION (isolated per option)
    // Try multiple variations to find the prediction (in case of case mismatches)
    let query = {
      user: req.user._id,
      type: 'market',
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;
    
    // Try to find prediction with normalized outcome (primary search)
    let prediction = await Prediction.findOne({ ...query, outcome: normalizedOutcome })
      .populate('match')
      .populate('poll');
    
    // If not found, try with original outcome (for option-based polls)
    if (!prediction) {
      prediction = await Prediction.findOne({ ...query, outcome: outcome })
        .populate('match')
        .populate('poll');
    }
    
    // If still not found, try uppercase version
    if (!prediction) {
      prediction = await Prediction.findOne({ ...query, outcome: outcome.toUpperCase() })
        .populate('match')
        .populate('poll');
    }
    
    // If still not found, try lowercase version
    if (!prediction) {
      prediction = await Prediction.findOne({ ...query, outcome: outcome.toLowerCase() })
        .populate('match')
        .populate('poll');
    }
    
    if (!prediction) {
      return res.status(404).json({ message: 'No market position found for this option' });
    }
    
    if (item.status === 'locked' || item.status === 'completed' || item.status === 'settled' || item.isResolved) {
      return res.status(400).json({ message: 'Item is locked or resolved' });
    }
    
    const currentShares = prediction.shares || 0;
    
    // Check if user has any shares for this option
    if (currentShares <= 0) {
      return res.status(400).json({ message: 'No shares to sell for this option' });
    }
    
    const sellShares = sharesToSell === 'max' || sharesToSell === 'all' 
      ? currentShares 
      : parseFloat(sharesToSell);
    
    if (sellShares <= 0 || sellShares > currentShares) {
      return res.status(400).json({ message: 'Invalid shares amount' });
    }
    
    // Use the prediction's stored outcome for calculations
    normalizedOutcome = prediction.outcome;
    
    // Calculate payout based on current market price
    let totalLiquidity = 0;
    let optionLiquidity = 0;
    let payout = 0;
    
    if (matchId) {
      totalLiquidity = (item.marketTeamALiquidity || 0) + (item.marketTeamBLiquidity || 0) + (item.marketDrawLiquidity || 0);
      if (normalizedOutcome === 'TEAMA') {
        optionLiquidity = item.marketTeamALiquidity || 0;
      } else if (normalizedOutcome === 'TEAMB') {
        optionLiquidity = item.marketTeamBLiquidity || 0;
      } else if (normalizedOutcome === 'DRAW') {
        optionLiquidity = item.marketDrawLiquidity || 0;
      }
    } else {
      // Handle poll
      if (item.optionType === 'options') {
        // Calculate total liquidity from all options
        totalLiquidity = item.options.reduce((sum, opt) => sum + (opt.liquidity || 0), 0);
        // Find the selected option using normalizedOutcome (from prediction)
        const selectedOption = item.options.find(opt => opt.text === normalizedOutcome || opt.text === outcome);
        if (selectedOption) {
          optionLiquidity = selectedOption.liquidity || 0;
        }
      } else {
        // Normal Yes/No poll
        totalLiquidity = (item.marketYesLiquidity || 0) + (item.marketNoLiquidity || 0);
        if (normalizedOutcome === 'YES') {
          optionLiquidity = item.marketYesLiquidity || 0;
        } else if (normalizedOutcome === 'NO') {
          optionLiquidity = item.marketNoLiquidity || 0;
        }
      }
    }
    
    // Fixed-Sum AMM Sell Logic:
    // Price per share = outcomeLiquidity / totalLiquidity (rounded to 4 decimals)
    // When selling Y shares: payout = Y * currentPrice
    // After selling: newLiquidity = oldLiquidity - payout, newTotal = oldTotal - payout
    
    // Calculate current price BEFORE selling (rounded to 4 decimals)
    const currentPrice = totalLiquidity > 0 
      ? parseFloat((optionLiquidity / totalLiquidity).toFixed(4)) 
      : 0;
    
    // Calculate payout: payout = shares * currentPrice
    if (currentPrice === 0) {
      return res.status(400).json({ message: 'Cannot calculate payout: price is 0' });
    }
    payout = parseFloat((sellShares * currentPrice).toFixed(4));
    
    // Update prediction
    prediction.shares = currentShares - sellShares;
    if (prediction.shares <= 0) {
      prediction.shares = 0;
    }
    prediction.updatedAt = new Date();
    
    // Update market liquidity (AMM: selling decreases option's pool, which decreases price)
    // Calculate new liquidity after removing payout
    const newOptionLiquidity = Math.max(0, optionLiquidity - payout);
    const newTotalLiquidity = Math.max(0, totalLiquidity - payout);
    
    if (matchId) {
      if (normalizedOutcome === 'TEAMA') {
        item.marketTeamALiquidity = newOptionLiquidity; // Decreased liquidity = lower price
        item.marketTeamAShares = Math.max(0, (item.marketTeamAShares || 0) - sellShares);
      } else if (normalizedOutcome === 'TEAMB') {
        item.marketTeamBLiquidity = newOptionLiquidity;
        item.marketTeamBShares = Math.max(0, (item.marketTeamBShares || 0) - sellShares);
      } else if (normalizedOutcome === 'DRAW') {
        item.marketDrawLiquidity = newOptionLiquidity;
        item.marketDrawShares = Math.max(0, (item.marketDrawShares || 0) - sellShares);
      }
    } else {
      // Handle poll
      if (item.optionType === 'options') {
        const selectedOption = item.options.find(opt => opt.text === outcome || opt.text === normalizedOutcome);
        if (selectedOption) {
          selectedOption.liquidity = newOptionLiquidity; // Decreased liquidity = lower price
          selectedOption.shares = Math.max(0, (selectedOption.shares || 0) - sellShares);
        }
      } else {
        if (normalizedOutcome === 'YES') {
          item.marketYesLiquidity = newOptionLiquidity;
          item.marketYesShares = Math.max(0, (item.marketYesShares || 0) - sellShares);
        } else if (normalizedOutcome === 'NO') {
          item.marketNoLiquidity = newOptionLiquidity;
          item.marketNoShares = Math.max(0, (item.marketNoShares || 0) - sellShares);
        }
      }
    }
    
    // Calculate new price after selling (should be lower, rounded to 4 decimals)
    const newPrice = newTotalLiquidity > 0 
      ? parseFloat((newOptionLiquidity / newTotalLiquidity).toFixed(4)) 
      : 0;
    
    await prediction.save();
    await item.save();
    
    // Reload item to get fresh data with updated prices
    const updatedItem = matchId 
      ? await Match.findById(matchId)
      : await Poll.findById(pollId);
    
    // Calculate updated prices for response
    let updatedPrices = {};
    let updatedTotalLiquidity = 0;
    
    if (matchId) {
      updatedTotalLiquidity = (updatedItem.marketTeamALiquidity || 0) + 
                              (updatedItem.marketTeamBLiquidity || 0) + 
                              (updatedItem.marketDrawLiquidity || 0);
      // Round all prices to 4 decimal places
      updatedPrices.teamA = updatedTotalLiquidity > 0 
        ? parseFloat(((updatedItem.marketTeamALiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
        : parseFloat((0.333).toFixed(4));
      updatedPrices.teamB = updatedTotalLiquidity > 0 
        ? parseFloat(((updatedItem.marketTeamBLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
        : parseFloat((0.333).toFixed(4));
      updatedPrices.draw = updatedTotalLiquidity > 0 
        ? parseFloat(((updatedItem.marketDrawLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
        : parseFloat((0.333).toFixed(4));
    } else {
      if (updatedItem.optionType === 'options') {
        updatedTotalLiquidity = updatedItem.options.reduce((sum, opt) => sum + (opt.liquidity || 0), 0);
        updatedItem.options.forEach(opt => {
          const defaultPrice = 1 / updatedItem.options.length;
          updatedPrices[opt.text] = updatedTotalLiquidity > 0 
            ? parseFloat(((opt.liquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
            : parseFloat(defaultPrice.toFixed(4));
        });
      } else {
        updatedTotalLiquidity = (updatedItem.marketYesLiquidity || 0) + (updatedItem.marketNoLiquidity || 0);
        updatedPrices.yes = updatedTotalLiquidity > 0 
          ? parseFloat(((updatedItem.marketYesLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
          : parseFloat((0.5).toFixed(4));
        updatedPrices.no = updatedTotalLiquidity > 0 
          ? parseFloat(((updatedItem.marketNoLiquidity || 0) / updatedTotalLiquidity).toFixed(4)) 
          : parseFloat((0.5).toFixed(4));
      }
    }
    
    // Verify prices sum to 1.0
    const priceSum = Object.values(updatedPrices).reduce((sum, price) => sum + price, 0);
    if (Math.abs(priceSum - 1.0) > 0.01) {
      console.warn('Prices do not sum to 1.0 after sell:', priceSum, updatedPrices);
    }

    // Create trade record for this sell transaction with full post-trade price snapshot.
    const trade = new Trade({
      user: req.user._id,
      match: matchId,
      poll: pollId,
      type: 'sell',
      outcome: normalizedOutcome,
      amount: payout,
      shares: sellShares,
      price: newPrice, // Price for the traded outcome after sell
      pricesSnapshot: updatedPrices, // Full post-trade prices
    });
    await trade.save();
    
    res.json({
      prediction,
      payout,
      sharesSold: sellShares,
      updatedItem,
      updatedPrices,
      newPrice,
      totalLiquidity: updatedTotalLiquidity,
      message: 'Sell successful. All prices updated.'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get market data (prices, trades, etc.)
router.get('/market/:itemId/data', async (req, res) => {
  try {
    const { itemId } = req.params;
    const { type } = req.query; // 'match' or 'poll'
    
    let item = null;
    if (type === 'match') {
      item = await Match.findById(itemId);
    } else {
      item = await Poll.findById(itemId);
    }
    
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }
    
    // Calculate current prices
    let prices = {};
    let totalLiquidity = 0;
    
    if (type === 'match') {
      totalLiquidity = (item.marketTeamALiquidity || 0) + (item.marketTeamBLiquidity || 0) + (item.marketDrawLiquidity || 0);
      prices.teamA = totalLiquidity === 0 ? 0.333 : (item.marketTeamALiquidity || 0) / totalLiquidity;
      prices.teamB = totalLiquidity === 0 ? 0.333 : (item.marketTeamBLiquidity || 0) / totalLiquidity;
      prices.draw = totalLiquidity === 0 ? 0.333 : (item.marketDrawLiquidity || 0) / totalLiquidity;
    } else {
      // Handle poll
      if (item.optionType === 'options') {
        // For option-based polls, calculate prices for each option
        totalLiquidity = item.options.reduce((sum, opt) => sum + (opt.liquidity || 0), 0);
        prices = {};
        item.options.forEach(opt => {
          prices[opt.text] = totalLiquidity === 0 ? (1 / item.options.length) : (opt.liquidity || 0) / totalLiquidity;
        });
      } else {
        // Normal Yes/No poll
        totalLiquidity = (item.marketYesLiquidity || 0) + (item.marketNoLiquidity || 0);
        prices.yes = totalLiquidity === 0 ? 0.5 : (item.marketYesLiquidity || 0) / totalLiquidity;
        prices.no = totalLiquidity === 0 ? 0.5 : (item.marketNoLiquidity || 0) / totalLiquidity;
      }
    }
    
    // Get all trades from Trade model to show trading activity
    const allTrades = await Trade.find({
      [type === 'match' ? 'match' : 'poll']: itemId,
    })
      .populate('user', 'username')
      .sort({ createdAt: -1 })
      .limit(100); // Show up to 100 recent trades
    
    // Format trades for display
    const formattedTrades = allTrades.map(trade => ({
      id: trade._id,
      user: trade.user?.username || 'Unknown',
      outcome: trade.outcome,
      shares: trade.shares || 0,
      amount: trade.amount || 0,
      price: trade.price || 0,
      pricesSnapshot: trade.pricesSnapshot || null,
      timestamp: trade.createdAt,
      type: trade.type, // 'buy' or 'sell'
    }));
    
    res.json({
      prices,
      totalLiquidity,
      recentTrades: formattedTrades,
      item: {
        id: item._id,
        status: item.status,
        isResolved: item.isResolved,
        result: item.result,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/**
 * Validates eligibility and returns EIP-191 signature from CLAIM_AUTH_PRIVATE_KEY (server-side, production-safe).
 */
async function handleClaimAuthorization(req, res) {
  try {
    const { walletAddress } = req.body || {};
    if (!walletAddress) {
      return res.status(400).json({ message: 'walletAddress is required' });
    }

    const claimSignerAddress = getClaimSignerAddress();
    if (!claimSignerAddress) {
      return res.status(503).json({
        message: 'Claims are not configured (set CLAIM_AUTH_PRIVATE_KEY on the server)',
      });
    }

    const contractAddressRaw =
      process.env.CONTRACT_ADDRESS || process.env.REACT_APP_CONTRACT_ADDRESS;
    const { getChainId } = require('../utils/chainConfig');
    const chainId = getChainId();
    if (!contractAddressRaw) {
      return res.status(500).json({
        message: 'Set CONTRACT_ADDRESS (or REACT_APP_CONTRACT_ADDRESS) on the server',
      });
    }

    const prediction = await Prediction.findById(req.params.predictionId)
      .populate('match')
      .populate('poll');

    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }

    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    if (prediction.claimed) {
      return res.status(400).json({ message: 'Already claimed' });
    }

    if (prediction.status !== 'settled' || !(prediction.payout > 0)) {
      return res.status(400).json({ message: 'No payout available' });
    }

    if (prediction.type !== 'boost' && prediction.type !== 'market') {
      return res.status(400).json({ message: 'Only boost or market predictions use this claim' });
    }

    const item = prediction.match || prediction.poll;
    if (!item || !item.isResolved || item.marketId == null) {
      return res.status(400).json({ message: 'Market not resolved or missing marketId' });
    }

    // Must claim with a wallet linked to this account.
    let signerAddr;
    try {
      signerAddr = ethers.getAddress(walletAddress);
    } catch {
      return res.status(400).json({ message: 'Invalid walletAddress' });
    }
    const addrLower = signerAddr.toLowerCase();
    const link = await WalletLink.findOne({ walletAddress: addrLower }).lean();
    if (!link) {
      return res.status(400).json({ message: 'Link a wallet to your account before claiming' });
    }
    if (String(link.user) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Connect the wallet linked to your profile' });
    }
    if (prediction.walletAddress && normalizeWalletAddress(prediction.walletAddress) !== addrLower) {
      return res.status(403).json({ message: 'Connect the wallet used for this position' });
    }

    const contractAddress = ethers.getAddress(contractAddressRaw);
    const deadlineSec = Math.floor(Date.now() / 1000) + 30 * 60;
    const predictionId = predictionIdToBytes32(prediction._id.toString());

    const isOrderbookMarket =
      prediction.type === 'market' &&
      (prediction.marketChannel === 'orderbook' || String(prediction.outcome || '').includes('|'));

    if (isOrderbookMarket) {
      const positionKey = prediction.outcome;
      try {
        await assertOrderbookClaimableOnChain({
          marketId: item.marketId,
          walletAddress: signerAddr,
          positionKey,
        });
      } catch (onChainErr) {
        const code = onChainErr.statusCode && Number.isInteger(onChainErr.statusCode) ? onChainErr.statusCode : 502;
        return res.status(code).json({ message: onChainErr.message || 'On-chain claim check failed' });
      }

      const amountWei = payoutToWei(prediction.payout);
      const { signature } = await signOrderbookPositionClaimPayload({
        userAddress: signerAddr,
        marketId: item.marketId,
        amountWei,
        positionKey,
        predictionId,
        deadlineSec,
        chainId,
        contractAddress,
      });

      return res.json({
        claimSignerAddress,
        claimKind: 'orderbook',
        contractAddress,
        chainId,
        marketId: item.marketId,
        positionKey,
        amountWei: amountWei.toString(),
        predictionId,
        deadline: deadlineSec,
        signature,
      });
    }

    const amountWei = payoutToWei(prediction.payout);
    const isBoost = prediction.type === 'boost';

    const { signature } = await signPredictionClaimPayload({
      userAddress: signerAddr,
      marketId: item.marketId,
      isBoost,
      amountWei,
      predictionId,
      deadlineSec,
      chainId,
      contractAddress,
    });

    res.json({
      claimSignerAddress,
      claimKind: isBoost ? 'boost' : 'amm',
      contractAddress,
      chainId,
      marketId: item.marketId,
      isBoost,
      amountWei: amountWei.toString(),
      predictionId,
      deadline: deadlineSec,
      signature,
    });
  } catch (error) {
    console.error('claim-authorization:', error);
    res.status(500).json({ message: error.message || 'Failed to authorize claim' });
  }
}

router.post('/:predictionId/claim-authorization', auth, handleClaimAuthorization);
/** @deprecated Use claim-authorization */
router.post('/:predictionId/claim-eligibility', auth, handleClaimAuthorization);

// Claim payout for a prediction (after successful on-chain tx)
router.post('/:predictionId/claim', auth, async (req, res) => {
  try {
    const prediction = await Prediction.findById(req.params.predictionId)
      .populate('match')
      .populate('poll');
    
    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }
    
    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    
    if (prediction.claimed) {
      return res.status(400).json({ message: 'Already claimed' });
    }
    
    if (prediction.status !== 'settled' || prediction.payout <= 0) {
      return res.status(400).json({ message: 'No payout available' });
    }
    
    const item = prediction.match || prediction.poll;
    if (!item || !item.isResolved) {
      return res.status(400).json({ message: 'Item not resolved' });
    }
    
    // Mark as claimed
    prediction.claimed = true;
    await prediction.save();
    
    // Update user balance (if you have a balance field)
    const user = await User.findById(req.user._id);
    if (user) {
      user.balance = (user.balance || 0) + prediction.payout;
      await user.save();
    }
    
    res.json({ prediction, message: 'Payout claimed successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
