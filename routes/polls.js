const express = require('express');
const Poll = require('../models/Poll');
const Cup = require('../models/Cup');
const { auth, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all polls
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;
    const query = type ? { type } : {};
    const polls = await Poll.find(query).populate('cup', 'name slug').sort({ createdAt: -1 });
    res.json(polls);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get poll by ID
router.get('/:id', async (req, res) => {
  try {
    const poll = await Poll.findById(req.params.id).populate('cup', 'name slug');
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }
    res.json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get polls by cup
router.get('/cup/:cupSlug', async (req, res) => {
  try {
    const { type } = req.query;
    const cup = await Cup.findOne({ slug: req.params.cupSlug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    const query = { cup: cup._id };
    if (type) {
      query.type = type;
    }

    const polls = await Poll.find(query).populate('stage', 'name').sort({ createdAt: -1 });
    res.json(polls);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create poll (Admin only)
router.post('/', auth, isAdmin, async (req, res) => {
  try {
    const poll = new Poll(req.body);
    await poll.save();
    res.status(201).json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update poll (Admin only)
router.put('/:id', auth, isAdmin, async (req, res) => {
  try {
    const poll = await Poll.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!poll) {
      return res.status(404).json({ message: 'Poll not found' });
    }
    res.json(poll);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
