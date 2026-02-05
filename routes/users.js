const express = require('express');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Prediction = require('../models/Prediction');

const router = express.Router();

// Get user profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Get additional stats
    const predictions = await Prediction.find({ user: user._id });
    const stats = {
      points: user.points || 0,
      streak: user.streak || 0,
      totalPredictions: predictions.length,
      correctPredictions: predictions.filter(p => p.status === 'won').length,
      tickets: user.tickets || 0,
    };

    res.json({
      ...user.toObject(),
      ...stats,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user by ID
router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
