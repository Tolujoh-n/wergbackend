const express = require('express');
const User = require('../models/User');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Cup = require('../models/Cup');
const Settings = require('../models/Settings');

const router = express.Router();

// Helper to get points per win from settings
async function getPointsPerWin() {
  const setting = await Settings.findOne({ key: 'pointsPerWin' });
  return setting ? (typeof setting.value === 'number' ? setting.value : parseFloat(setting.value) || 10) : 10;
}

// Get leaderboard
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    const pointsPerWin = await getPointsPerWin();
    
    // Get all users
    let users = await User.find().lean();
    console.log(`[Leaderboard] Found ${users.length} users`);
    
    // Calculate stats for each user
    for (const user of users) {
      const predictions = await Prediction.find({ user: user._id });
      const freePredictions = predictions.filter(p => p.type === 'free');
      const boostPredictions = predictions.filter(p => p.type === 'boost');
      const marketPredictions = predictions.filter(p => p.type === 'market');
      
      if (type === 'free') {
        user.points = freePredictions.filter(p => p.status === 'won').length * pointsPerWin;
      } else if (type === 'boost') {
        user.points = boostPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
      } else if (type === 'market') {
        user.points = marketPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
      } else {
        // For 'all', use total points from correct predictions + boost/market payouts
        const wonPredictions = predictions.filter(p => p.status === 'won');
        const freeWon = wonPredictions.filter(p => p.type === 'free').length;
        const boostPayouts = boostPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
        const marketPayouts = marketPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
        user.points = (freeWon * pointsPerWin) + boostPayouts + marketPayouts;
      }
      
      user.totalPredictions = predictions.length;
      user.correctPredictions = predictions.filter(p => p.status === 'won').length;
      
      // Ensure streak is included from user model
      if (!user.streak) {
        user.streak = 0;
      }
    }
    
    // Filter out users with no predictions
    const usersWithPredictions = users.filter(u => (u.totalPredictions || 0) > 0);
    console.log(`[Leaderboard] Users with predictions: ${usersWithPredictions.length}`);
    
    // Sort by points, then by correct predictions
    usersWithPredictions.sort((a, b) => {
      if ((b.points || 0) !== (a.points || 0)) {
        return (b.points || 0) - (a.points || 0);
      }
      return (b.correctPredictions || 0) - (a.correctPredictions || 0);
    });
    
    // Pagination: 20 rows per page
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const result = usersWithPredictions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(usersWithPredictions.length / limit);
    
    console.log(`[Leaderboard] Returning ${result.length} users (page ${page}/${totalPages})`);
    res.json({
      users: result,
      pagination: {
        currentPage: page,
        totalPages,
        totalUsers: usersWithPredictions.length,
        hasNext: endIndex < usersWithPredictions.length,
        hasPrev: page > 1
      }
    });
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
    const pointsPerWin = await getPointsPerWin();
    
    const cup = await Cup.findOne({ slug: cupSlug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }
    
    const matches = await Match.find({ cup: cup._id });
    const matchIds = matches.map(m => m._id);
    
    // Get predictions for both matches and polls in this cup
    const matchPredictions = await Prediction.find({ match: { $in: matchIds } });
    const polls = await Poll.find({ cup: cup._id });
    const pollIds = polls.map(p => p._id);
    const pollPredictions = await Prediction.find({ poll: { $in: pollIds } });
    const predictions = [...matchPredictions, ...pollPredictions];
    
    const userIds = [...new Set(predictions.map(p => p.user.toString()))];
    
    let users = await User.find({ _id: { $in: userIds } }).lean();
    
    // Calculate stats for each user for this cup
    for (const user of users) {
      const userPredictions = predictions.filter(p => p.user.toString() === user._id.toString());
      const freePredictions = userPredictions.filter(p => p.type === 'free');
      const boostPredictions = userPredictions.filter(p => p.type === 'boost');
      const marketPredictions = userPredictions.filter(p => p.type === 'market');
      
      if (type === 'free') {
        user.points = freePredictions.filter(p => p.status === 'won').length * pointsPerWin;
      } else if (type === 'boost') {
        user.points = boostPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
      } else if (type === 'market') {
        user.points = marketPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
      } else {
        // For 'all', combine all types
        const freeWon = freePredictions.filter(p => p.status === 'won').length;
        const boostPayouts = boostPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
        const marketPayouts = marketPredictions
          .filter(p => p.status === 'won')
          .reduce((sum, p) => sum + (p.payout || 0), 0);
        user.points = (freeWon * pointsPerWin) + boostPayouts + marketPayouts;
      }
      
      user.totalPredictions = userPredictions.length;
      user.correctPredictions = userPredictions.filter(p => p.status === 'won').length;
      
      // Ensure streak is included from user model
      if (!user.streak) {
        user.streak = 0;
      }
    }
    
    // Filter out users with no predictions for this cup
    const usersWithPredictions = users.filter(u => (u.totalPredictions || 0) > 0);
    console.log(`[Leaderboard Cup] Users with predictions: ${usersWithPredictions.length}`);
    
    usersWithPredictions.sort((a, b) => {
      if ((b.points || 0) !== (a.points || 0)) {
        return (b.points || 0) - (a.points || 0);
      }
      return (b.correctPredictions || 0) - (a.correctPredictions || 0);
    });
    
    // Pagination: 20 rows per page
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    const result = usersWithPredictions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(usersWithPredictions.length / limit);
    
    console.log(`[Leaderboard Cup] Returning ${result.length} users (page ${page}/${totalPages})`);
    res.json({
      users: result,
      pagination: {
        currentPage: page,
        totalPages,
        totalUsers: usersWithPredictions.length,
        hasNext: endIndex < usersWithPredictions.length,
        hasPrev: page > 1
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
