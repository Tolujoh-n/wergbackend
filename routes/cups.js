const express = require('express');
const Cup = require('../models/Cup');
const Stage = require('../models/Stage');
const Match = require('../models/Match');
const Poll = require('../models/Poll');

const router = express.Router();

// Get all cups
router.get('/', async (req, res) => {
  try {
    const cups = await Cup.find().sort({ createdAt: -1 });
    res.json(cups);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get cups for navbar (only those with showInNavbar: true)
router.get('/navbar', async (req, res) => {
  try {
    const cups = await Cup.find({ showInNavbar: true })
      .sort({ navbarOrder: 1, createdAt: -1 })
      .select('name slug');
    res.json(cups);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get cup by slug
router.get('/slug/:slug', async (req, res) => {
  try {
    const cup = await Cup.findOne({ slug: req.params.slug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }
    res.json(cup);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get stages for a cup
router.get('/:cupSlug/stages', async (req, res) => {
  try {
    const cup = await Cup.findOne({ slug: req.params.cupSlug });
    if (!cup) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    const stages = await Stage.find({ cup: cup._id }).sort({ order: 1 });
    res.json(stages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
