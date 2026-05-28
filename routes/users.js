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

// Check if username is available (for profile edit). Query: ?username=xxx
router.get('/check-username', auth, async (req, res) => {
  try {
    const { username } = req.query;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ available: false, message: 'Username required' });
    }
    const trimmed = username.trim();
    if (trimmed.length < 5) {
      return res.json({ available: false, message: 'Username must be at least 5 characters' });
    }
    if (/\s/.test(trimmed)) {
      return res.json({ available: false, message: 'Username cannot contain spaces' });
    }
    const existing = await User.findOne({ username: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    const isCurrentUser = existing && req.user._id && existing._id.toString() === req.user._id.toString();
    return res.json({ available: !existing || isCurrentUser, message: existing && !isCurrentUser ? 'Username already taken' : null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update profile (username)
router.patch('/profile', auth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ message: 'Username is required' });
    }
    const trimmed = username.trim();
    if (trimmed.length < 5) {
      return res.status(400).json({ message: 'Username must be at least 5 characters' });
    }
    if (/\s/.test(trimmed)) {
      return res.status(400).json({ message: 'Username cannot contain spaces' });
    }
    const existing = await User.findOne({ username: new RegExp(`^${trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if (existing && existing._id.toString() !== req.user._id.toString()) {
      return res.status(400).json({ message: 'Username already taken' });
    }
    const user = await User.findByIdAndUpdate(req.user._id, { username: trimmed }, { new: true }).select('-password');
    res.json(user);
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
