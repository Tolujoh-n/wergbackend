const express = require('express');
const { auth, isSuperAdmin } = require('../middleware/auth');
const Settings = require('../models/Settings');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const SuperAdminTransaction = require('../models/SuperAdminTransaction');

const router = express.Router();

// Get fees endpoint (public - fees should be visible to all users)
router.get('/get-fees', async (req, res) => {
  try {
    const getFee = async (key, defaultValue) => {
      const setting = await Settings.findOne({ key });
      return setting ? (typeof setting.value === 'number' ? setting.value : parseFloat(setting.value) || defaultValue) : defaultValue;
    };
    
    res.json({
      platformFee: await getFee('platformFee', 10),
      boostJackpotFee: await getFee('boostJackpotFee', 5),
      marketPlatformFee: await getFee('marketPlatformFee', 5),
      freeJackpotFee: await getFee('freeJackpotFee', 5),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// All other superadmin routes require authentication and superAdmin role
router.use(auth);
router.use(isSuperAdmin);

// Log a super admin contract transaction/action
router.post('/transactions', async (req, res) => {
  try {
    const {
      action,
      txHash,
      chainId,
      ethAmount,
      usdAmount,
      ethUsd,
      meta,
    } = req.body || {};

    if (!action || !String(action).trim()) {
      return res.status(400).json({ message: 'action is required' });
    }

    const doc = new SuperAdminTransaction({
      actor: req.user._id,
      action: String(action).trim(),
      txHash: txHash ? String(txHash).trim() : undefined,
      chainId: chainId != null ? Number(chainId) : undefined,
      ethAmount: ethAmount != null && ethAmount !== '' ? Number(ethAmount) : undefined,
      usdAmount: usdAmount != null && usdAmount !== '' ? Number(usdAmount) : undefined,
      ethUsd: ethUsd != null && ethUsd !== '' ? Number(ethUsd) : undefined,
      meta: meta && typeof meta === 'object' ? meta : {},
    });

    await doc.save();
    await doc.populate('actor', 'username walletAddress role');
    res.status(201).json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get super admin transactions (paginated)
router.get('/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [total, rows] = await Promise.all([
      SuperAdminTransaction.countDocuments(),
      SuperAdminTransaction.find()
        .populate('actor', 'username walletAddress role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
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

// Set fees
router.post('/set-fees', async (req, res) => {
  try {
    const { platformFee, boostJackpotFee, marketPlatformFee, freeJackpotFee } = req.body;
    
    // Validate fees are percentages (0-100)
    if (platformFee < 0 || platformFee > 100 || boostJackpotFee < 0 || boostJackpotFee > 100 ||
        marketPlatformFee < 0 || marketPlatformFee > 100 || freeJackpotFee < 0 || freeJackpotFee > 100) {
      return res.status(400).json({ message: 'Fees must be between 0 and 100' });
    }
    
    // Store fees in Settings
    const feeSettings = [
      { key: 'platformFee', value: platformFee, description: 'Platform fee percentage for boost predictions' },
      { key: 'boostJackpotFee', value: boostJackpotFee, description: 'Boost jackpot fee percentage' },
      { key: 'marketPlatformFee', value: marketPlatformFee, description: 'Platform fee percentage for market predictions' },
      { key: 'freeJackpotFee', value: freeJackpotFee, description: 'Free jackpot fee percentage for market predictions' },
    ];
    
    for (const feeSetting of feeSettings) {
      let setting = await Settings.findOne({ key: feeSetting.key });
      if (setting) {
        setting.value = feeSetting.value;
        setting.description = feeSetting.description;
        await setting.save();
      } else {
        setting = new Settings(feeSetting);
        await setting.save();
      }
    }
    
    res.json({ message: 'Fees set successfully', fees: { platformFee, boostJackpotFee, marketPlatformFee, freeJackpotFee } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});


// Get contract balance (placeholder)
router.get('/contract-balance', async (req, res) => {
  try {
    // Fetch from smart contract
    res.json({ balance: '0.0' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Transfer funds (placeholder)
router.post('/transfer', async (req, res) => {
  try {
    const { to, amount } = req.body;
    // Call smart contract transfer function
    res.json({ message: 'Transfer successful', to, amount });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Set superAdmin address (placeholder)
router.post('/set-superadmin', async (req, res) => {
  try {
    const { address } = req.body;
    // Update in smart contract
    res.json({ message: 'SuperAdmin address set successfully', address });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get matches with jackpot and fee data
router.get('/matches', async (req, res) => {
  try {
    const matches = await Match.find()
      .populate('cup', 'name slug')
      .populate('stage', 'name')
      .select('teamA teamB date status isResolved freeJackpotPool boostJackpotPool originalFreeJackpotPool originalBoostJackpotPool platformFees cup stage createdAt')
      .sort({ createdAt: -1 });
    
    res.json(matches);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get polls with jackpot and fee data
router.get('/polls', async (req, res) => {
  try {
    const polls = await Poll.find()
      .populate('cup', 'name slug')
      .populate('stage', 'name')
      .select('question type status isResolved freeJackpotPool boostJackpotPool originalFreeJackpotPool originalBoostJackpotPool platformFees cup stage createdAt')
      .sort({ createdAt: -1 });
    
    res.json(polls);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
