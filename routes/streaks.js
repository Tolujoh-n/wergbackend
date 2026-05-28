const express = require('express');
const { auth } = require('../middleware/auth');
const User = require('../models/User');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Cup = require('../models/Cup');

const router = express.Router();

/**
 * @param {{ status: string, createdAt?: Date }[]} predAsc - free predictions, oldest → newest
 */
function computeFreeStreakMetrics(predAsc) {
  let longestStreak = 0;
  let run = 0;
  for (const p of predAsc) {
    if (p.status === 'won') {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
    } else if (p.status === 'lost') {
      run = 0;
    }
  }
  let currentStreak = 0;
  for (let i = predAsc.length - 1; i >= 0; i--) {
    const p = predAsc[i];
    if (p.status === 'won') currentStreak += 1;
    else break;
  }
  return { currentStreak, longestStreak };
}

// Get top streaks
router.get('/', async (req, res) => {
  try {
    const users = await User.find()
      .select('username email walletAddress streak correctPredictions totalPredictions points')
      .lean();

    const usersWithStreaks = [];
    for (const user of users) {
      const preds = await Prediction.find({ user: user._id, type: 'free' })
        .select('status createdAt')
        .sort({ createdAt: 1 })
        .lean();

      const { currentStreak, longestStreak } = computeFreeStreakMetrics(preds);
      const correctPredictions = preds.filter((p) => p.status === 'won').length;

      if (currentStreak > 0 || preds.length > 0) {
        usersWithStreaks.push({
          ...user,
          streak: currentStreak,
          currentStreak,
          longestStreak,
          correctPredictions,
        });
      }
    }

    usersWithStreaks.sort(
      (a, b) =>
        (b.currentStreak || 0) - (a.currentStreak || 0) ||
        (b.longestStreak || 0) - (a.longestStreak || 0) ||
        (b.correctPredictions || 0) - (a.correctPredictions || 0)
    );

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
    const matchIds = matches.map((m) => m._id);
    const pollIds = polls.map((p) => p._id);

    const predictions = await Prediction.find({
      $or: [{ match: { $in: matchIds } }, { poll: { $in: pollIds } }],
      type: 'free',
    })
      .select('user status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const userPredictions = {};
    for (const prediction of predictions) {
      const userId = prediction.user.toString();
      if (!userPredictions[userId]) userPredictions[userId] = [];
      userPredictions[userId].push(prediction);
    }

    const userIds = Object.keys(userPredictions);
    if (userIds.length === 0) {
      return res.json([]);
    }

    const globalPreds = await Prediction.find({
      user: { $in: userIds },
      type: 'free',
    })
      .select('user status createdAt')
      .sort({ createdAt: 1 })
      .lean();

    const globalByUser = new Map();
    for (const p of globalPreds) {
      const id = String(p.user);
      if (!globalByUser.has(id)) globalByUser.set(id, []);
      globalByUser.get(id).push(p);
    }

    const users = await User.find({ _id: { $in: userIds } })
      .select('username email walletAddress streak correctPredictions totalPredictions points')
      .lean();

    const result = [];
    for (const uid of userIds) {
      const cupAsc = (userPredictions[uid] || []).sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );
      const cupMetrics = computeFreeStreakMetrics(cupAsc);
      if (cupMetrics.currentStreak <= 0) continue;

      const globalAsc = globalByUser.get(uid) || [];
      const globalMetrics = computeFreeStreakMetrics(globalAsc);
      const correctPredictions = globalAsc.filter((p) => p.status === 'won').length;

      const u = users.find((x) => String(x._id) === uid);
      if (!u) continue;

      result.push({
        ...u,
        streak: cupMetrics.currentStreak,
        currentStreak: cupMetrics.currentStreak,
        longestStreak: globalMetrics.longestStreak,
        correctPredictions,
      });
    }

    result.sort(
      (a, b) =>
        (b.currentStreak || 0) - (a.currentStreak || 0) ||
        (b.longestStreak || 0) - (a.longestStreak || 0) ||
        (b.correctPredictions || 0) - (a.correctPredictions || 0)
    );

    res.json(result.slice(0, 50));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get user's streak
router.get('/user', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const preds = await Prediction.find({ user: user._id, type: 'free' })
      .select('status createdAt')
      .sort({ createdAt: 1 })
      .lean();

    const { currentStreak, longestStreak } = computeFreeStreakMetrics(preds);
    const correctPredictions = preds.filter((p) => p.status === 'won').length;

    if (currentStreak > (user.streak || 0)) {
      user.streak = currentStreak;
      await user.save();
    }

    res.json({
      currentStreak,
      longestStreak,
      bestStreak: longestStreak,
      correctPredictions,
      history: [],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
