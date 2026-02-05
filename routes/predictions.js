const express = require('express');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const User = require('../models/User');
const Settings = require('../models/Settings');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get all predictions for authenticated user
router.get('/user', auth, async (req, res) => {
  try {
    const predictions = await Prediction.find({ user: req.user._id })
      .populate('match', 'teamA teamB date status result')
      .populate('poll', 'question type')
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
    const user = await User.findById(req.user._id);

    if (!matchId && !pollId) {
      return res.status(400).json({ message: 'Either matchId or pollId is required' });
    }

    // Get daily free play limit from settings
    const settings = await Settings.findOne();
    const dailyFreePlayLimit = settings?.freePlayLimit || 1;

    // Check if user has a ticket
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastTicketDate = user.lastTicketDate ? new Date(user.lastTicketDate) : null;

    if (!lastTicketDate || lastTicketDate < today) {
      // Give new tickets based on daily limit
      user.tickets = dailyFreePlayLimit;
      user.lastTicketDate = today;
    }

    if (user.tickets < 1) {
      return res.status(400).json({ message: `No tickets available. You can make ${dailyFreePlayLimit} free prediction(s) per day. Come back tomorrow!` });
    }

    // Check if user already predicted
    const query = {
      user: user._id,
      type: 'free',
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;

    const existingPrediction = await Prediction.findOne(query);

    // If prediction exists and item is still upcoming, allow update
    if (existingPrediction) {
      let item = null;
      if (matchId) {
        item = await Match.findById(matchId);
      } else {
        item = await Poll.findById(pollId);
      }
      
      if (item && (item.status === 'upcoming' || item.status === 'active')) {
        // Update existing prediction
        existingPrediction.outcome = outcome;
        existingPrediction.updatedAt = new Date();
        await existingPrediction.save();
        return res.json(existingPrediction);
      }
      
      return res.status(400).json({ message: 'You already predicted this item' });
    }

    const prediction = new Prediction({
      user: user._id,
      match: matchId,
      poll: pollId,
      type: 'free',
      outcome,
    });

    await prediction.save();

    // Deduct ticket
    user.tickets -= 1;
    user.totalPredictions += 1;
    await user.save();

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

    // Check if user already has a boost prediction
    const query = {
      user: req.user._id,
      type: 'boost',
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;

    const existingBoostPrediction = await Prediction.findOne(query);

    // If prediction exists and item is still upcoming, allow update
    if (existingBoostPrediction) {
      if (item.status === 'upcoming' || item.status === 'active') {
        // Update existing prediction
        existingBoostPrediction.outcome = outcome;
        existingBoostPrediction.updatedAt = new Date();
        await existingBoostPrediction.save();
        return res.json(existingBoostPrediction);
      }
      return res.status(400).json({ message: 'You already have a boost prediction for this item' });
    }

    const prediction = new Prediction({
      user: req.user._id,
      match: matchId,
      poll: pollId,
      type: 'boost',
      outcome,
      amount,
      totalStake: amount, // Initialize total stake
    });

    await prediction.save();

    // Update boost pool
    if (matchId) {
      item.boostPool += amount;
      await item.save();
    } else {
      item.boostPool = (item.boostPool || 0) + amount;
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
    
    const prediction = await Prediction.findOne(query)
      .populate('match', 'teamA teamB date status result isResolved');
    
    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
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
    
    const prediction = await Prediction.findOne(query)
      .populate('poll', 'question type status result isResolved');
    
    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
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
    
    // For boost predictions, preserve the amount (totalStake) when updating outcome
    const oldOutcome = prediction.outcome;
    prediction.outcome = outcome;
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
    
    // Check if item is still upcoming
    const item = prediction.match || prediction.poll;
    if (!item || (item.status !== 'upcoming' && item.status !== 'active')) {
      return res.status(400).json({ message: 'Cannot modify stake. Item is not upcoming' });
    }
    
    const stakeAmount = parseFloat(amount);
    
    if (action === 'add') {
      prediction.totalStake = (prediction.totalStake || prediction.amount || 0) + stakeAmount;
      prediction.amount = prediction.totalStake;
      
      // Update boost pool
      if (prediction.match) {
        item.boostPool = (item.boostPool || 0) + stakeAmount;
      } else {
        item.boostPool = (item.boostPool || 0) + stakeAmount;
      }
    } else if (action === 'withdraw') {
      const currentStake = prediction.totalStake || prediction.amount || 0;
      if (stakeAmount > currentStake) {
        return res.status(400).json({ message: 'Cannot withdraw more than current stake' });
      }
      
      prediction.totalStake = currentStake - stakeAmount;
      prediction.amount = prediction.totalStake;
      
      // Update boost pool
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
    const { matchId, pollId, outcome, amount } = req.body;
    
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
      if (!['teamA', 'teamB', 'draw'].includes(outcome)) {
        return res.status(400).json({ message: 'Invalid outcome for match' });
      }
    } else {
      item = await Poll.findById(pollId);
      if (!item) {
        return res.status(404).json({ message: 'Poll not found' });
      }
      if (!['yes', 'no', 'YES', 'NO'].includes(outcome)) {
        return res.status(400).json({ message: 'Invalid outcome for poll' });
      }
    }
    
    if (item.status === 'locked' || item.status === 'completed' || item.status === 'settled' || item.isResolved) {
      return res.status(400).json({ message: 'Item is locked or resolved' });
    }
    
    if (!item.marketInitialized) {
      return res.status(400).json({ message: 'Market not initialized' });
    }
    
    const investAmount = parseFloat(amount);
    const normalizedOutcome = outcome.toUpperCase();
    
    // Calculate shares based on current liquidity (simplified AMM)
    let shares = 0;
    let totalLiquidity = 0;
    let optionLiquidity = 0;
    
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
      totalLiquidity = (item.marketYesLiquidity || 0) + (item.marketNoLiquidity || 0);
      if (normalizedOutcome === 'YES') {
        optionLiquidity = item.marketYesLiquidity || 0;
      } else if (normalizedOutcome === 'NO') {
        optionLiquidity = item.marketNoLiquidity || 0;
      }
    }
    
    if (totalLiquidity === 0) {
      return res.status(400).json({ message: 'Market not initialized' });
    }
    
    // Calculate shares using constant product formula (simplified)
    shares = (investAmount * optionLiquidity) / (totalLiquidity + investAmount);
    
    // Find or create prediction
    const query = {
      user: req.user._id,
      type: 'market',
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;
    
    let prediction = await Prediction.findOne(query);
    
    if (prediction) {
      // Update existing prediction
      prediction.shares = (prediction.shares || 0) + shares;
      prediction.totalInvested = (prediction.totalInvested || 0) + investAmount;
      prediction.outcome = normalizedOutcome;
    } else {
      // Create new prediction
      prediction = new Prediction({
        user: req.user._id,
        match: matchId,
        poll: pollId,
        type: 'market',
        outcome: normalizedOutcome,
        shares: shares,
        totalInvested: investAmount,
      });
    }
    
    // Update market liquidity
    if (matchId) {
      if (normalizedOutcome === 'TEAMA') {
        item.marketTeamALiquidity = (item.marketTeamALiquidity || 0) + investAmount;
        item.marketTeamAShares = (item.marketTeamAShares || 0) + shares;
      } else if (normalizedOutcome === 'TEAMB') {
        item.marketTeamBLiquidity = (item.marketTeamBLiquidity || 0) + investAmount;
        item.marketTeamBShares = (item.marketTeamBShares || 0) + shares;
      } else if (normalizedOutcome === 'DRAW') {
        item.marketDrawLiquidity = (item.marketDrawLiquidity || 0) + investAmount;
        item.marketDrawShares = (item.marketDrawShares || 0) + shares;
      }
    } else {
      if (normalizedOutcome === 'YES') {
        item.marketYesLiquidity = (item.marketYesLiquidity || 0) + investAmount;
        item.marketYesShares = (item.marketYesShares || 0) + shares;
      } else if (normalizedOutcome === 'NO') {
        item.marketNoLiquidity = (item.marketNoLiquidity || 0) + investAmount;
        item.marketNoShares = (item.marketNoShares || 0) + shares;
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

// Market: Sell shares
router.post('/market/sell', auth, async (req, res) => {
  try {
    const { matchId, pollId, shares: sharesToSell } = req.body;
    
    if (!matchId && !pollId) {
      return res.status(400).json({ message: 'Either matchId or pollId is required' });
    }
    
    const query = {
      user: req.user._id,
      type: 'market',
    };
    if (matchId) query.match = matchId;
    if (pollId) query.poll = pollId;
    
    const prediction = await Prediction.findOne(query)
      .populate('match')
      .populate('poll');
    
    if (!prediction) {
      return res.status(404).json({ message: 'No market position found' });
    }
    
    let item = prediction.match || prediction.poll;
    if (!item) {
      return res.status(404).json({ message: 'Item not found' });
    }
    
    if (item.status === 'locked' || item.status === 'completed' || item.status === 'settled' || item.isResolved) {
      return res.status(400).json({ message: 'Item is locked or resolved' });
    }
    
    const currentShares = prediction.shares || 0;
    const sellShares = sharesToSell === 'max' || sharesToSell === 'all' 
      ? currentShares 
      : parseFloat(sharesToSell);
    
    if (sellShares <= 0 || sellShares > currentShares) {
      return res.status(400).json({ message: 'Invalid shares amount' });
    }
    
    // Calculate payout based on current market price
    const normalizedOutcome = prediction.outcome.toUpperCase();
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
      totalLiquidity = (item.marketYesLiquidity || 0) + (item.marketNoLiquidity || 0);
      if (normalizedOutcome === 'YES') {
        optionLiquidity = item.marketYesLiquidity || 0;
      } else if (normalizedOutcome === 'NO') {
        optionLiquidity = item.marketNoLiquidity || 0;
      }
    }
    
    if (totalLiquidity > 0 && optionLiquidity > 0) {
      // Calculate payout (simplified - in real AMM this would be more complex)
      payout = (sellShares * totalLiquidity) / (optionLiquidity + sellShares);
    }
    
    // Update prediction
    prediction.shares = currentShares - sellShares;
    if (prediction.shares <= 0) {
      prediction.shares = 0;
    }
    prediction.updatedAt = new Date();
    
    // Update market liquidity
    if (matchId) {
      if (normalizedOutcome === 'TEAMA') {
        item.marketTeamALiquidity = Math.max(0, (item.marketTeamALiquidity || 0) - payout);
        item.marketTeamAShares = Math.max(0, (item.marketTeamAShares || 0) - sellShares);
      } else if (normalizedOutcome === 'TEAMB') {
        item.marketTeamBLiquidity = Math.max(0, (item.marketTeamBLiquidity || 0) - payout);
        item.marketTeamBShares = Math.max(0, (item.marketTeamBShares || 0) - sellShares);
      } else if (normalizedOutcome === 'DRAW') {
        item.marketDrawLiquidity = Math.max(0, (item.marketDrawLiquidity || 0) - payout);
        item.marketDrawShares = Math.max(0, (item.marketDrawShares || 0) - sellShares);
      }
    } else {
      if (normalizedOutcome === 'YES') {
        item.marketYesLiquidity = Math.max(0, (item.marketYesLiquidity || 0) - payout);
        item.marketYesShares = Math.max(0, (item.marketYesShares || 0) - sellShares);
      } else if (normalizedOutcome === 'NO') {
        item.marketNoLiquidity = Math.max(0, (item.marketNoLiquidity || 0) - payout);
        item.marketNoShares = Math.max(0, (item.marketNoShares || 0) - sellShares);
      }
    }
    
    await prediction.save();
    await item.save();
    
    res.json({
      prediction,
      payout,
      sharesSold: sellShares,
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
      totalLiquidity = (item.marketYesLiquidity || 0) + (item.marketNoLiquidity || 0);
      prices.yes = totalLiquidity === 0 ? 0.5 : (item.marketYesLiquidity || 0) / totalLiquidity;
      prices.no = totalLiquidity === 0 ? 0.5 : (item.marketNoLiquidity || 0) / totalLiquidity;
    }
    
    // Get all market predictions to show trading activity
    const allMarketPredictions = await Prediction.find({
      [type === 'match' ? 'match' : 'poll']: itemId,
      type: 'market',
    })
      .populate('user', 'username')
      .sort({ updatedAt: -1 })
      .limit(100); // Show up to 100 recent trades
    
    // Format trades for display - show each prediction as a buy trade
    // When users sell, we could track that separately, but for now we show all market positions
    const formattedTrades = allMarketPredictions.map(trade => ({
      id: trade._id,
      user: trade.user?.username || 'Unknown',
      outcome: trade.outcome,
      shares: trade.shares || 0,
      totalInvested: trade.totalInvested || 0,
      timestamp: trade.updatedAt || trade.createdAt,
      type: 'buy', // All market predictions are purchases (sells reduce shares but don't create new predictions)
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

module.exports = router;
