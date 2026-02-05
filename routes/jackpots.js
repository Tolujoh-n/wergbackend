const express = require('express');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Cup = require('../models/Cup');

const router = express.Router();

// Get jackpots
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    
    // Calculate jackpot pools from fees
    const boostPredictions = await Prediction.find({ type: 'boost' });
    const marketPredictions = await Prediction.find({ type: 'market' });
    
    const boostPool = boostPredictions.length > 0 
      ? boostPredictions.reduce((sum, p) => sum + ((p.amount || 0) * 0.1), 0)
      : 10.0; // Default minimum pool
    const freePool = marketPredictions.length > 0
      ? marketPredictions.reduce((sum, p) => sum + ((p.amount || 0) * 0.05), 0)
      : 500; // Default minimum pool in points
    
    const jackpots = [
      {
        _id: 'daily-free',
        name: 'Daily Free Jackpot',
        type: 'free',
        amount: Math.floor(freePool * 0.3),
        participants: await getEligibleUsers('free', 'daily'),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        minStreak: 3,
        minPredictions: 5,
      },
      {
        _id: 'daily-boost',
        name: 'Daily Boost Jackpot',
        type: 'boost',
        amount: boostPool * 0.3,
        participants: await getEligibleUsers('boost', 'daily'),
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        minStreak: 5,
        minPredictions: 10,
      },
      {
        _id: 'tournament-free',
        name: 'Tournament Free Jackpot',
        type: 'free',
        amount: Math.floor(freePool * 0.5),
        participants: await getEligibleUsers('free', 'tournament'),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        minStreak: 10,
        minPredictions: 20,
      },
      {
        _id: 'tournament-boost',
        name: 'Tournament Boost Jackpot',
        type: 'boost',
        amount: boostPool * 0.5,
        participants: await getEligibleUsers('boost', 'tournament'),
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        minStreak: 15,
        minPredictions: 30,
      },
    ];
    
    const filtered = type && type !== 'all' 
      ? jackpots.filter(j => j.type === type)
      : jackpots;
    
    // Ensure minimum values for display
    for (const jackpot of filtered) {
      if (jackpot.amount <= 0) {
        jackpot.amount = jackpot.type === 'free' ? 100 : 0.1;
      }
      if (jackpot.participants <= 0) {
        jackpot.participants = 1;
      }
    }
    
    // Add user eligibility if authenticated (optional)
    if (req.user) {
      const userId = req.user._id;
      for (const jackpot of filtered) {
        jackpot.userEligible = await checkEligibility(userId, jackpot);
        jackpot.userChance = jackpot.userEligible && jackpot.participants > 0 
          ? (1 / jackpot.participants * 100).toFixed(2) 
          : 0;
      }
    }
    
    res.json(filtered);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get jackpots for a specific cup
router.get('/cup/:cupSlug', async (req, res) => {
  try {
    const { cupSlug } = req.params;
    const { type } = req.query;
    
    const cup = await Cup.findOne({ slug: cupSlug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }
    
    const matches = await Match.find({ cup: cup._id });
    const matchIds = matches.map(m => m._id);
    
    const boostPredictions = await Prediction.find({ 
      type: 'boost',
      match: { $in: matchIds }
    });
    const marketPredictions = await Prediction.find({ 
      type: 'market',
      match: { $in: matchIds }
    });
    
    const boostPool = boostPredictions.reduce((sum, p) => sum + (p.amount * 0.1), 0);
    const freePool = marketPredictions.reduce((sum, p) => sum + (p.amount * 0.05), 0);
    
    const jackpots = [
      {
        _id: `cup-${cupSlug}-free`,
        name: `${cup.name} Free Jackpot`,
        type: 'free',
        amount: Math.floor(freePool * 0.5),
        participants: await getEligibleUsers('free', 'cup', cup._id),
        endDate: cup.endDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        minStreak: 5,
        minPredictions: 10,
      },
      {
        _id: `cup-${cupSlug}-boost`,
        name: `${cup.name} Boost Jackpot`,
        type: 'boost',
        amount: boostPool * 0.5,
        participants: await getEligibleUsers('boost', 'cup', cup._id),
        endDate: cup.endDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        minStreak: 10,
        minPredictions: 20,
      },
    ];
    
    const filtered = type && type !== 'all' 
      ? jackpots.filter(j => j.type === type)
      : jackpots;
    
    // Ensure minimum values for display
    for (const jackpot of filtered) {
      if (jackpot.amount <= 0) {
        jackpot.amount = jackpot.type === 'free' ? 100 : 0.1;
      }
      if (jackpot.participants <= 0) {
        jackpot.participants = 1;
      }
    }
    
    // Add user eligibility if authenticated (optional)
    if (req.user) {
      const userId = req.user._id;
      for (const jackpot of filtered) {
        jackpot.userEligible = await checkEligibility(userId, jackpot, cup._id);
        jackpot.userChance = jackpot.userEligible && jackpot.participants > 0
          ? (1 / jackpot.participants * 100).toFixed(2)
          : 0;
      }
    }
    
    res.json(filtered);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

async function getEligibleUsers(type, period, cupId = null) {
  const users = await User.find();
  let eligible = 0;
  
  for (const user of users) {
    const predictions = cupId
      ? await Prediction.find({ user: user._id, match: { $in: await getMatchIds(cupId) } })
      : await Prediction.find({ user: user._id });
    
    const correctPredictions = predictions.filter(p => p.status === 'won' && p.type === type);
    const streak = user.streak || 0;
    
    if (period === 'daily') {
      if (correctPredictions.length >= 5 && streak >= 3) eligible++;
    } else {
      if (correctPredictions.length >= 20 && streak >= 10) eligible++;
    }
  }
  
  return eligible;
}

async function checkEligibility(userId, jackpot, cupId = null) {
  const user = await User.findById(userId);
  if (!user) return false;
  
  const predictions = cupId
      ? await Prediction.find({ user: userId, match: { $in: await getMatchIds(cupId) } })
      : await Prediction.find({ user: userId });
  
  const correctPredictions = predictions.filter(p => p.status === 'won' && p.type === jackpot.type);
  const streak = user.streak || 0;
  
  return correctPredictions.length >= jackpot.minPredictions && streak >= jackpot.minStreak;
}

async function getMatchIds(cupId) {
  const matches = await Match.find({ cup: cupId });
  return matches.map(m => m._id);
}

module.exports = router;
