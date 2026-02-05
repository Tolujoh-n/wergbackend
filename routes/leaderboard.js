const express = require('express');
const User = require('../models/User');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Cup = require('../models/Cup');

const router = express.Router();

// Get leaderboard
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    
    let users = await User.find().lean();
    
    // Calculate stats for each user
    for (const user of users) {
      const predictions = await Prediction.find({ user: user._id });
      const freePredictions = predictions.filter(p => p.type === 'free');
      const boostPredictions = predictions.filter(p => p.type === 'boost');
      
      if (type === 'free') {
        user.points = freePredictions.filter(p => p.status === 'won').length * 10;
      } else if (type === 'boost') {
        user.points = boostPredictions.reduce((sum, p) => sum + (p.payout || 0), 0);
      } else {
        // For 'all', use total points from correct predictions
        user.points = (user.points || 0) + (predictions.filter(p => p.status === 'won').length * 10);
      }
      
      user.totalPredictions = predictions.length;
      user.correctPredictions = predictions.filter(p => p.status === 'won').length;
    }
    
    // Sort by points, then by correct predictions
    users.sort((a, b) => {
      if ((b.points || 0) !== (a.points || 0)) {
        return (b.points || 0) - (a.points || 0);
      }
      return (b.correctPredictions || 0) - (a.correctPredictions || 0);
    });
    
    res.json(users.slice(0, 100));
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get leaderboard for a specific cup
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
    
    const predictions = await Prediction.find({ match: { $in: matchIds } });
    const userIds = [...new Set(predictions.map(p => p.user.toString()))];
    
    let users = await User.find({ _id: { $in: userIds } }).lean();
    
    // Calculate stats for each user for this cup
    for (const user of users) {
      const userPredictions = predictions.filter(p => p.user.toString() === user._id.toString());
      
      if (type === 'free') {
        user.points = userPredictions.filter(p => p.type === 'free' && p.status === 'won').length * 10;
      } else if (type === 'boost') {
        user.points = userPredictions.filter(p => p.type === 'boost').reduce((sum, p) => sum + (p.payout || 0), 0);
      } else {
        user.points = userPredictions.filter(p => p.status === 'won').length * 10;
      }
      
      user.totalPredictions = userPredictions.length;
      user.correctPredictions = userPredictions.filter(p => p.status === 'won').length;
    }
    
    users.sort((a, b) => (b.points || 0) - (a.points || 0));
    
    res.json(users.slice(0, 100));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
