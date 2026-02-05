const express = require('express');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Cup = require('../models/Cup');

const router = express.Router();

// Get top streaks
router.get('/', async (req, res) => {
  try {
    const users = await User.find()
      .sort({ streak: -1, correctPredictions: -1 })
      .limit(50)
      .select('username email walletAddress streak correctPredictions totalPredictions points');
    
    // Ensure we return an array even if empty
    res.json(users || []);
  } catch (error) {
    console.error('Streaks error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get streaks for a specific cup
router.get('/cup/:cupSlug', async (req, res) => {
  try {
    const { cupSlug } = req.params;
    
    const cup = await Cup.findOne({ slug: cupSlug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }
    
    const matches = await Match.find({ cup: cup._id });
    const matchIds = matches.map(m => m._id);
    
    const predictions = await Prediction.find({ 
      match: { $in: matchIds },
      type: 'free',
      status: 'won'
    }).sort({ createdAt: 1 });
    
    // Calculate streaks per user for this cup
    const userStreaks = {};
    
    for (const prediction of predictions) {
      const userId = prediction.user.toString();
      if (!userStreaks[userId]) {
        userStreaks[userId] = { current: 0, best: 0 };
      }
      userStreaks[userId].current += 1;
      userStreaks[userId].best = Math.max(userStreaks[userId].best, userStreaks[userId].current);
    }
    
    const users = await User.find({ _id: { $in: Object.keys(userStreaks) } });
    const result = users.map(user => ({
      ...user.toObject(),
      streak: userStreaks[user._id.toString()].best,
    }));
    
    result.sort((a, b) => b.streak - a.streak);
    
    res.json(result.slice(0, 50));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user's streak
router.get('/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    // Get recent predictions to calculate streak
    const predictions = await Prediction.find({ 
      user: user._id,
      type: 'free',
      status: 'won'
    }).sort({ createdAt: -1 }).limit(100);
    
    let currentStreak = 0;
    let bestStreak = 0;
    let tempStreak = 0;
    
    for (const prediction of predictions) {
      tempStreak += 1;
      bestStreak = Math.max(bestStreak, tempStreak);
    }
    
    currentStreak = user.streak || 0;
    
    res.json({
      currentStreak,
      bestStreak,
      history: [], // Can be expanded to track streak history
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
