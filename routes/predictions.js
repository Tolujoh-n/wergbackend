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
} = require('../utils/claimAuth');

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
    boostJackpotFee: await getFee('boostJackpotFee', 5),
    marketPlatformFee: await getFee('marketPlatformFee', 5),
    freeJackpotFee: await getFee('freeJackpotFee', 5),
  };
}

/**
 * Normalize match outcome to contract canonical form: TeamA, TeamB, or Draw.
 * Accepts team names (e.g. "Poland"), "teamA"/"TeamA"/"TEAMA", etc.
 * @param {string} outcome - Raw outcome from client
 * @param {string} teamA - Match team A name
 * @param {string} teamB - Match team B name
 * @returns {string|null} 'TeamA' | 'TeamB' | 'Draw' or null if invalid
 */
function normalizeMatchOutcome(outcome, teamA, teamB) {
  if (!outcome || typeof outcome !== 'string') return null;
  const raw = String(outcome).trim();
  const lower = raw.toLowerCase();
  const teamALower = (teamA || '').trim().toLowerCase();
  const teamBLower = (teamB || '').trim().toLowerCase();
  if (lower === 'teama' || (teamALower && lower === teamALower)) return 'TeamA';
  if (lower === 'teamb' || (teamBLower && lower === teamBLower)) return 'TeamB';
  if (lower === 'draw') return 'Draw';
  return null;
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

// Create free prediction
router.post('/free', auth, async (req, res) => {
  try {
    const { matchId, pollId, outcome } = req.body;
    
    if (!matchId && !pollId) {
      return res.status(400).json({ message: 'Either matchId or pollId is required' });
    }

    // Get daily free play limit from settings
    const settings = await Settings.findOne({ key: 'dailyFreePlayLimit' });
    const dailyFreePlayLimit = settings && settings.value ? parseInt(settings.value) : 1;

    // Fetch user and check/update tickets
    const user = await User.findById(req.user._id);

    // Check if user already predicted
    const query = {
      user: user._id,
      type: 'free',
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;

    const existingPrediction = await Prediction.findOne(query);

    // If prediction exists and item is still upcoming, allow update (no ticket needed)
    if (existingPrediction) {
      let item = null;
      if (matchId) {
        item = await Match.findById(matchId);
      } else {
        item = await Poll.findById(pollId);
      }
      
      if (item && (item.status === 'upcoming' || item.status === 'active')) {
        // Update existing prediction (no ticket deduction)
        existingPrediction.outcome = outcome;
        existingPrediction.updatedAt = new Date();
        await existingPrediction.save();
        return res.json(existingPrediction);
      }
      
      return res.status(400).json({ message: 'You already predicted this item' });
    }

    // For new predictions, check tickets
    // Check if user has a ticket - tickets are shared across all cups per day
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    today.setMinutes(0, 0, 0);
    today.setSeconds(0, 0);
    today.setMilliseconds(0);
    
    // Re-fetch user to get latest data
    let currentUser = await User.findById(req.user._id);
    
    const lastTicketDate = currentUser.lastTicketDate ? new Date(currentUser.lastTicketDate) : null;
    let lastTicketDateNormalized = null;
    if (lastTicketDate) {
      lastTicketDateNormalized = new Date(lastTicketDate);
      lastTicketDateNormalized.setHours(0, 0, 0, 0);
      lastTicketDateNormalized.setMinutes(0, 0, 0);
      lastTicketDateNormalized.setSeconds(0, 0);
      lastTicketDateNormalized.setMilliseconds(0);
    }

    // Check if we need to reset tickets
    const isNewDay = !lastTicketDateNormalized || lastTicketDateNormalized.getTime() < today.getTime();
    const hasInvalidTickets = currentUser.tickets === null || 
                              currentUser.tickets === undefined || 
                              isNaN(currentUser.tickets);
    // Also reset if tickets are 0 and it's a new day (edge case handling)
    const hasZeroTickets = currentUser.tickets === 0;
    const needsReset = isNewDay || hasInvalidTickets || (hasZeroTickets && isNewDay);

    console.log(`[FREE PREDICTION] User ${currentUser._id} - Current tickets: ${currentUser.tickets}, Last ticket date: ${currentUser.lastTicketDate}, Daily limit: ${dailyFreePlayLimit}`);
    console.log(`[FREE PREDICTION] Is new day: ${isNewDay}, Has invalid tickets: ${hasInvalidTickets}, Has zero tickets: ${hasZeroTickets}, Needs reset: ${needsReset}`);
    console.log(`[FREE PREDICTION] Today: ${today.toISOString()}, Last date: ${lastTicketDateNormalized ? lastTicketDateNormalized.toISOString() : 'null'}`);

    // Reset tickets if needed
    if (needsReset) {
      // Give new tickets based on daily limit
      currentUser.tickets = dailyFreePlayLimit;
      currentUser.lastTicketDate = today;
      await currentUser.save(); // Save immediately to ensure tickets are updated
      console.log(`[FREE PREDICTION] Tickets reset for user ${currentUser._id}. New tickets: ${dailyFreePlayLimit}`);
      
      // Re-fetch to confirm the save
      currentUser = await User.findById(req.user._id);
      console.log(`[FREE PREDICTION] After reset - User ${currentUser._id} tickets: ${currentUser.tickets}`);
    }

    console.log(`[FREE PREDICTION] User ${currentUser._id} - Tickets available: ${currentUser.tickets || 0}, Daily limit: ${dailyFreePlayLimit}`);

    // Final check: if tickets are still 0 or invalid after reset attempt, force reset
    if ((!currentUser.tickets || currentUser.tickets < 1) && isNewDay) {
      console.log(`[FREE PREDICTION] Force resetting tickets for user ${currentUser._id} - tickets were ${currentUser.tickets}`);
      currentUser.tickets = dailyFreePlayLimit;
      currentUser.lastTicketDate = today;
      await currentUser.save();
      currentUser = await User.findById(req.user._id);
      console.log(`[FREE PREDICTION] After force reset - User ${currentUser._id} tickets: ${currentUser.tickets}`);
    }

    // Check if user has tickets available
    const ticketsAvailable = currentUser.tickets && !isNaN(currentUser.tickets) && currentUser.tickets > 0;
    if (!ticketsAvailable) {
      console.log(`[FREE PREDICTION] No tickets available for user ${currentUser._id}. Current tickets: ${currentUser.tickets}, Type: ${typeof currentUser.tickets}`);
      return res.status(400).json({ message: `No tickets available. You can make ${dailyFreePlayLimit} free prediction(s) per day. Come back tomorrow!` });
    }

    const prediction = new Prediction({
      user: currentUser._id,
      match: matchId,
      poll: pollId,
      type: 'free',
      outcome,
    });

    await prediction.save();

    // Deduct ticket and update user
    currentUser.tickets -= 1;
    currentUser.totalPredictions += 1;
    await currentUser.save();

    console.log(`[FREE PREDICTION] Ticket deducted for user ${currentUser._id}. Remaining tickets: ${currentUser.tickets}`);

    res.status(201).json(prediction);
  } catch (error) {
    res.status(500).json({ message: error.message });
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

    if (item.status === 'locked' || item.status === 'completed' || item.status === 'settled') {
      return res.status(400).json({ message: 'Item is locked or completed' });
    }

    // Normalize outcome for matches to contract canonical form (TeamA, TeamB, Draw)
    let outcomeToStore = outcome;
    if (matchId && item.teamA != null && item.teamB != null) {
      const normalized = normalizeMatchOutcome(outcome, item.teamA, item.teamB);
      if (!normalized) {
        return res.status(400).json({ message: 'Invalid outcome for match. Use Team A, Team B, or Draw.' });
      }
      outcomeToStore = normalized;
    }

    // Check if user already has a boost prediction
    const query = {
      user: req.user._id,
      type: 'boost',
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;

    const linkedWallet = await assertWalletLinkedToUser({
      userId: req.user._id,
      walletAddress: req.body.walletAddress,
    });

    const existingBoostPrediction = await Prediction.findOne(query);

    // If prediction exists and item is still upcoming, allow update
    if (existingBoostPrediction) {
      if (item.status === 'upcoming' || item.status === 'active') {
        // Update existing prediction with normalized outcome
        existingBoostPrediction.outcome = outcomeToStore;
        existingBoostPrediction.updatedAt = new Date();
        await existingBoostPrediction.save();
        return res.json(existingBoostPrediction);
      }
      return res.status(400).json({ message: 'You already have a boost prediction for this item' });
    }

    // Get fees from settings
    const fees = await getFees();
    const stakeAmount = parseFloat(amount);
    
    // Calculate fees (percentages)
    const platformFeeAmount = (stakeAmount * fees.platformFee) / 100;
    const boostJackpotFeeAmount = (stakeAmount * fees.boostJackpotFee) / 100;
    const netStakeAmount = stakeAmount - platformFeeAmount - boostJackpotFeeAmount;
    
    const prediction = new Prediction({
      user: req.user._id,
      match: matchId,
      poll: pollId,
      type: 'boost',
      outcome: outcomeToStore,
      walletAddress: linkedWallet,
      amount: netStakeAmount, // Store net amount after fees
      totalStake: netStakeAmount, // Initialize total stake (net)
    });

    await prediction.save();

    // Update boost pool with net amount (after fees)
    if (matchId) {
      item.boostPool = (item.boostPool || 0) + netStakeAmount;
      item.boostJackpotPool = (item.boostJackpotPool || 0) + boostJackpotFeeAmount;
      item.platformFees = (item.platformFees || 0) + platformFeeAmount;
      await item.save();
    } else {
      item.boostPool = (item.boostPool || 0) + netStakeAmount;
      item.boostJackpotPool = (item.boostJackpotPool || 0) + boostJackpotFeeAmount;
      item.platformFees = (item.platformFees || 0) + platformFeeAmount;
      await item.save();
    }

    // Update user stats
    const user = await User.findById(req.user._id);
    user.totalPredictions += 1;
    await user.save();

    res.status(201).json(prediction);
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
    
    // For market type, return all predictions (one per option)
    if (type === 'market') {
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
    
    // For market type, return all predictions (one per option)
    if (type === 'market') {
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
    if (!item || (item.status !== 'upcoming' && item.status !== 'active')) {
      return res.status(400).json({ message: 'Cannot update prediction. Item is not upcoming' });
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

// Boost: Add or withdraw stake
router.post('/boost/:predictionId/stake', auth, async (req, res) => {
  try {
    const linkedWallet = await assertWalletLinkedToUser({
      userId: req.user._id,
      walletAddress: req.body.walletAddress,
    });
    const { action, amount } = req.body; // action: 'add' or 'withdraw'

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
    if (!item || (item.status !== 'upcoming' && item.status !== 'active')) {
      return res.status(400).json({ message: 'Cannot modify stake. Item is not upcoming' });
    }
    
    const stakeAmount = parseFloat(amount);
    
    // Get fees from settings
    const fees = await getFees();
    
    if (action === 'add') {
      // Calculate fees for adding stake
      const platformFeeAmount = (stakeAmount * fees.platformFee) / 100;
      const boostJackpotFeeAmount = (stakeAmount * fees.boostJackpotFee) / 100;
      const netStakeAmount = stakeAmount - platformFeeAmount - boostJackpotFeeAmount;
      
      prediction.totalStake = (prediction.totalStake || prediction.amount || 0) + netStakeAmount;
      prediction.amount = prediction.totalStake;
      
      // Update boost pool with net amount and fees
      if (prediction.match) {
        item.boostPool = (item.boostPool || 0) + netStakeAmount;
        item.boostJackpotPool = (item.boostJackpotPool || 0) + boostJackpotFeeAmount;
        item.platformFees = (item.platformFees || 0) + platformFeeAmount;
      } else {
        item.boostPool = (item.boostPool || 0) + netStakeAmount;
        item.boostJackpotPool = (item.boostJackpotPool || 0) + boostJackpotFeeAmount;
        item.platformFees = (item.platformFees || 0) + platformFeeAmount;
      }
    } else if (action === 'withdraw') {
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
    
    res.json(prediction);
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
    const chainId = parseInt(process.env.CHAIN_ID || '84532', 10);
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

    const amountWei = payoutToWei(prediction.payout);
    const deadlineSec = Math.floor(Date.now() / 1000) + 30 * 60;
    const isBoost = prediction.type === 'boost';
    const contractAddress = ethers.getAddress(contractAddressRaw);
    const predictionId = predictionIdToBytes32(prediction._id.toString());

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
