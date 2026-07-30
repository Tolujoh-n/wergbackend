const express = require('express');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const {
  getEngagementStreakPayload,
  applyDecay,
  ensureEngagementStreaks,
  syncTotalStreak,
  utcDayKey,
} = require('../services/engagementStreakService');

const router = express.Router();

// Leaderboard helper: top users by total engagement streak
router.get('/', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const today = utcDayKey();
    const users = await User.find()
      .select('username walletAddress streak engagementStreaks correctPredictions totalPredictions points')
      .lean();

    const rows = users.map((u) => {
      const e = u.engagementStreaks || {};
      const login = applyDecay(e.login, today);
      const free = applyDecay(e.free, today);
      const boost = applyDecay(e.boost, today);
      const currentStreak =
        (login.current || 0) + (free.current || 0) + (boost.current || 0);
      const longestStreak =
        (login.best || 0) + (free.best || 0) + (boost.best || 0);
      return {
        _id: u._id,
        username: u.username,
        walletAddress: u.walletAddress,
        correctPredictions: u.correctPredictions || 0,
        totalPredictions: u.totalPredictions || 0,
        points: u.points || 0,
        streak: currentStreak,
        currentStreak,
        longestStreak,
      };
    });

    rows.sort(
      (a, b) =>
        (b.currentStreak || 0) - (a.currentStreak || 0) ||
        (b.longestStreak || 0) - (a.longestStreak || 0)
    );

    res.json(rows.filter((r) => (r.currentStreak || 0) > 0).slice(0, limit));
  } catch (error) {
    console.error('Streaks error:', error);
    res.status(500).json({ message: error.message });
  }
});

router.get('/cup/:cupSlug', async (req, res) => {
  res.json([]);
});

// Current user's engagement streaks (login + free + boost)
router.get('/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    ensureEngagementStreaks(user);
    const today = utcDayKey();
    user.engagementStreaks.login = applyDecay(user.engagementStreaks.login, today);
    user.engagementStreaks.free = applyDecay(user.engagementStreaks.free, today);
    user.engagementStreaks.boost = applyDecay(user.engagementStreaks.boost, today);
    syncTotalStreak(user);
    await user.save();

    res.json(getEngagementStreakPayload(user));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
