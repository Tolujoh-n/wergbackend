const express = require('express');
const { auth } = require('../middleware/auth');
const UserTransaction = require('../models/UserTransaction');

const router = express.Router();

router.use(auth);

// Log a user transaction (called by frontend after successful blockchain tx)
router.post('/', async (req, res) => {
  try {
    const { action, txHash, amount, currency, itemType, itemId, meta } = req.body || {};
    if (!action || !String(action).trim()) {
      return res.status(400).json({ message: 'action is required' });
    }

    const doc = new UserTransaction({
      user: req.user._id,
      action: String(action).trim(),
      txHash: txHash ? String(txHash).trim() : undefined,
      amount: amount != null && amount !== '' ? Number(amount) : undefined,
      currency: currency === 'ETH' ? 'ETH' : 'USDC',
      itemType: ['match', 'poll'].includes(itemType) ? itemType : 'none',
      itemId: itemId ? String(itemId) : undefined,
      meta: meta && typeof meta === 'object' ? meta : {},
    });
    await doc.save();
    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get current user's transactions (paginated)
router.get('/me', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      UserTransaction.countDocuments({ user: req.user._id }),
      UserTransaction.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.json({
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      rows,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;

