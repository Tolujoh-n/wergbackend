const express = require('express');
const { auth } = require('../middleware/auth');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const User = require('../models/User');

const router = express.Router();

// Get user's claimable predictions
router.get('/user', auth, async (req, res) => {
  try {
    const predictions = await Prediction.find({
      user: req.user._id,
      status: 'won',
      payout: { $gt: 0 },
    })
      .populate('match', 'teamA teamB result')
      .populate('poll', 'question result')
      .sort({ createdAt: -1 });

    res.json(predictions);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Claim payout for a prediction
router.post('/:predictionId', auth, async (req, res) => {
  try {
    const prediction = await Prediction.findById(req.params.predictionId)
      .populate('match')
      .populate('poll');

    if (!prediction) {
      return res.status(404).json({ message: 'Prediction not found' });
    }

    if (prediction.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    if (prediction.status !== 'won' || prediction.payout <= 0) {
      return res.status(400).json({ message: 'Nothing to claim' });
    }

    // Mark as settled
    prediction.status = 'settled';
    await prediction.save();

    // Update user points/balance (for free predictions, add points)
    const user = await User.findById(req.user._id);
    if (prediction.type === 'free') {
      user.points += 10; // Award points for correct free prediction
      // Update streak
      user.streak += 1;
      user.correctPredictions += 1;
    } else if (prediction.type === 'boost') {
      // In real implementation, transfer ETH here
      // For now, just mark as claimed
      user.correctPredictions += 1;
    }
    await user.save();

    res.json({ message: 'Claimed successfully', prediction });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Claim all payouts
router.post('/claim/all', auth, async (req, res) => {
  try {
    const predictions = await Prediction.find({
      user: req.user._id,
      status: 'won',
      payout: { $gt: 0 },
    });

    let totalPoints = 0;
    let totalPayout = 0;

    for (const prediction of predictions) {
      if (prediction.type === 'free') {
        totalPoints += 10;
      } else if (prediction.type === 'boost') {
        totalPayout += prediction.payout;
      }
      prediction.status = 'settled';
      await prediction.save();
    }

    const user = await User.findById(req.user._id);
    user.points += totalPoints;
    user.correctPredictions += predictions.length;
    await user.save();

    res.json({ message: 'All claims processed', totalPoints, totalPayout });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
