const express = require('express');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Cup = require('../models/Cup');

const router = express.Router();

// Get top streaks
router.get('/', async (req, res) => {
  try {
    // Get all users
    const users = await User.find()
      .select('username email walletAddress streak correctPredictions totalPredictions points');
    console.log(`[Streaks] Found ${users.length} users`);
    
    // Calculate actual streaks from predictions
    const usersWithStreaks = [];
    for (const user of users) {
      // Get recent predictions for streak calculation (limit to 100 for performance)
      const recentPredictions = await Prediction.find({ 
        user: user._id,
        type: 'free'
      }).sort({ createdAt: -1 }).limit(100);
      
      // Calculate current streak (consecutive wins from most recent)
      let currentStreak = 0;
      for (const prediction of recentPredictions) {
        if (prediction.status === 'won') {
          currentStreak++;
        } else if (prediction.status === 'lost') {
          break; // Streak broken
        }
      }
      
      // Calculate correct predictions count (all free predictions with status 'won', not just recent 100)
      const allFreePredictions = await Prediction.find({ 
        user: user._id,
        type: 'free',
        status: 'won'
      });
      const correctPredictions = allFreePredictions.length;
      
      const finalStreak = Math.max(currentStreak, user.streak || 0);
      
      // Include users with at least 1 streak OR users with predictions (even if streak is 0)
      if (finalStreak > 0 || recentPredictions.length > 0) {
        usersWithStreaks.push({
          ...user.toObject(),
          streak: finalStreak,
          correctPredictions: correctPredictions
        });
      }
    }
    
    // Sort by streak
    usersWithStreaks.sort((a, b) => (b.streak || 0) - (a.streak || 0));
    
    console.log(`[Streaks] Returning ${usersWithStreaks.length} users with streaks`);
    res.json(usersWithStreaks.slice(0, 50));
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
    const polls = await Poll.find({ cup: cup._id });
    const matchIds = matches.map(m => m._id);
    const pollIds = polls.map(p => p._id);
    
    // Get all predictions for this cup (both won and lost)
    const predictions = await Prediction.find({ 
      $or: [
        { match: { $in: matchIds } },
        { poll: { $in: pollIds } }
      ],
      type: 'free'
    }).sort({ createdAt: -1 }); // Most recent first
    
    // Calculate streaks per user for this cup
    const userStreaks = {};
    
    // Group predictions by user
    const userPredictions = {};
    for (const prediction of predictions) {
      const userId = prediction.user.toString();
      if (!userPredictions[userId]) {
        userPredictions[userId] = [];
      }
      userPredictions[userId].push(prediction);
    }
    
    // Calculate streaks for each user
    for (const userId in userPredictions) {
      const userPreds = userPredictions[userId].sort((a, b) => 
        new Date(b.createdAt) - new Date(a.createdAt)
      );
      
      let currentStreak = 0;
      let bestStreak = 0;
      let tempStreak = 0;
      
      for (const pred of userPreds) {
        if (pred.status === 'won') {
          currentStreak = currentStreak === 0 ? 1 : currentStreak + 1;
          tempStreak++;
          bestStreak = Math.max(bestStreak, tempStreak);
        } else if (pred.status === 'lost') {
          if (currentStreak > 0) break; // Streak broken
          tempStreak = 0;
        }
      }
      
      userStreaks[userId] = Math.max(currentStreak, bestStreak);
    }
    
    const userIds = Object.keys(userStreaks).filter(uid => userStreaks[uid] > 0);
    const users = await User.find({ _id: { $in: userIds } })
      .select('username email walletAddress streak correctPredictions totalPredictions points');
    
    // Calculate correct predictions for each user
    const result = await Promise.all(users.map(async (user) => {
      // Count correct free predictions for this cup
      const userPreds = predictions.filter(p => p.user.toString() === user._id.toString());
      const correctPredictions = userPreds.filter(p => p.status === 'won').length;
      
      return {
        ...user.toObject(),
        streak: userStreaks[user._id.toString()] || 0,
        correctPredictions: correctPredictions
      };
    }));
    
    result.sort((a, b) => b.streak - a.streak);
    
    console.log(`[Streaks Cup] Returning ${result.length} users with streaks`);
    res.json(result.slice(0, 50));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user's streak
router.get('/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    // Get recent predictions to calculate streak (consecutive wins)
    const allPredictions = await Prediction.find({ 
      user: user._id,
      type: 'free'
    }).sort({ createdAt: -1 }).limit(100);
    
    // Calculate current streak (consecutive wins from most recent)
    let currentStreak = 0;
    for (const prediction of allPredictions) {
      if (prediction.status === 'won') {
        currentStreak++;
      } else {
        break; // Streak broken
      }
    }
    
    // Calculate best streak (longest consecutive wins)
    let bestStreak = 0;
    let tempStreak = 0;
    const sortedPredictions = [...allPredictions].reverse(); // Oldest first
    for (const prediction of sortedPredictions) {
      if (prediction.status === 'won') {
        tempStreak++;
        bestStreak = Math.max(bestStreak, tempStreak);
      } else {
        tempStreak = 0; // Reset streak
      }
    }
    
    // Update user streak if current streak is higher
    if (currentStreak > (user.streak || 0)) {
      user.streak = currentStreak;
      await user.save();
    }
    
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
