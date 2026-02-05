const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const router = express.Router();

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: '7d',
  });
};

// Signup with email/password
router.post('/signup', async (req, res) => {
  try {
    const { email, password, username } = req.body;

    let user = await User.findOne({ $or: [{ email }, { username }] });
    if (user) {
      return res.status(400).json({ message: 'User already exists' });
    }

    user = new User({ email, password, username });
    await user.save();

    const token = generateToken(user._id);
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Login with email/password
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user || !user.password) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = generateToken(user._id);
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Login/Signup with wallet
router.post('/wallet-login', async (req, res) => {
  try {
    const { address } = req.body;
    const walletAddress = address.toLowerCase();

    let user = await User.findOne({ walletAddress });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const token = generateToken(user._id);
    res.json({ token, user: { id: user._id, username: user.username, walletAddress: user.walletAddress, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Signup with wallet
router.post('/wallet-signup', async (req, res) => {
  try {
    const { address } = req.body;
    const walletAddress = address.toLowerCase();

    let user = await User.findOne({ walletAddress });
    if (user) {
      const token = generateToken(user._id);
      return res.json({ token, user: { id: user._id, username: user.username, walletAddress: user.walletAddress, role: user.role } });
    }

    const username = `user_${walletAddress.slice(0, 8)}`;
    user = new User({ walletAddress, username });
    await user.save();

    const token = generateToken(user._id);
    res.json({ token, user: { id: user._id, username: user.username, walletAddress: user.walletAddress, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json({ user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
