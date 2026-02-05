const express = require('express');
const Match = require('../models/Match');
const Cup = require('../models/Cup');
const Stage = require('../models/Stage');
const { auth, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all matches
router.get('/', async (req, res) => {
  try {
    const matches = await Match.find()
      .populate('cup', 'name slug')
      .populate('stage', 'name')
      .sort({ date: 1 });
    res.json(matches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get match by ID
router.get('/:id', async (req, res) => {
  try {
    const match = await Match.findById(req.params.id)
      .populate('cup', 'name slug')
      .populate('stage', 'name');
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get matches by cup
router.get('/cup/:cupSlug', async (req, res) => {
  try {
    const cup = await Cup.findOne({ slug: req.params.cupSlug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    const matches = await Match.find({ cup: cup._id })
      .populate('stage', 'name')
      .sort({ date: 1 });

    const matchesWithStageName = matches.map(match => ({
      ...match.toObject(),
      stageName: match.stage?.name || 'Unknown',
    }));

    res.json(matchesWithStageName);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create match (Admin only)
router.post('/', auth, isAdmin, async (req, res) => {
  try {
    const { teamA, teamB, date, cup, stage } = req.body;

    const cupDoc = typeof cup === 'string' ? await Cup.findById(cup) : cup;
    if (!cupDoc) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    let stageDoc = null;
    if (stage) {
      stageDoc = typeof stage === 'string' ? await Stage.findById(stage) : stage;
    }

    const match = new Match({
      teamA,
      teamB,
      date: new Date(date),
      cup: cupDoc._id,
      stage: stageDoc?._id,
      stageName: stageDoc?.name,
    });

    await match.save();
    res.status(201).json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update match (Admin only)
router.put('/:id', auth, isAdmin, async (req, res) => {
  try {
    const match = await Match.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Set match result (Admin only)
router.post('/:id/result', auth, isAdmin, async (req, res) => {
  try {
    const { result } = req.body;
    const match = await Match.findByIdAndUpdate(
      req.params.id,
      { result, status: 'completed' },
      { new: true }
    );
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    res.json(match);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
