const express = require('express');
const Stage = require('../models/Stage');
const Cup = require('../models/Cup');
const { auth, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Get all stages (public)
router.get('/', async (req, res) => {
  try {
    const { cupId } = req.query;
    const query = cupId ? { cup: cupId } : {};
    const stages = await Stage.find(query).populate('cup', 'name slug').sort({ order: 1 });
    res.json(stages);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get stage by ID
router.get('/:id', async (req, res) => {
  try {
    const stage = await Stage.findById(req.params.id).populate('cup', 'name slug');
    if (!stage) {
      return res.status(404).json({ message: 'Stage not found' });
    }
    res.json(stage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create stage (Admin only)
router.post('/', auth, isAdmin, async (req, res) => {
  try {
    const { name, cup, order, startDate, endDate } = req.body;

    const cupDoc = typeof cup === 'string' ? await Cup.findById(cup) : await Cup.findOne({ slug: cup });
    if (!cupDoc) {
      return res.status(404).json({ message: 'Cup not found' });
    }

    const stage = new Stage({
      name,
      cup: cupDoc._id,
      order: order || 0,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
    });

    await stage.save();
    res.status(201).json(stage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update stage (Admin only)
router.put('/:id', auth, isAdmin, async (req, res) => {
  try {
    const stage = await Stage.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!stage) {
      return res.status(404).json({ message: 'Stage not found' });
    }
    res.json(stage);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete stage (Admin only)
router.delete('/:id', auth, isAdmin, async (req, res) => {
  try {
    const stage = await Stage.findByIdAndDelete(req.params.id);
    if (!stage) {
      return res.status(404).json({ message: 'Stage not found' });
    }
    res.json({ message: 'Stage deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
