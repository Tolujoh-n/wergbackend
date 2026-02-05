const express = require('express');
const { auth, isSuperAdmin } = require('../middleware/auth');

const router = express.Router();

// All superadmin routes require authentication and superAdmin role
router.use(auth);
router.use(isSuperAdmin);

// Set fees (placeholder - will integrate with smart contract)
router.post('/set-fees', async (req, res) => {
  try {
    const { platformFee, boostJackpotFee, marketPlatformFee, freeJackpotFee } = req.body;
    // Store in database or call smart contract
    res.json({ message: 'Fees set successfully', fees: req.body });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get fees
router.get('/get-fees', async (req, res) => {
  try {
    // Fetch from database or smart contract
    res.json({
      platformFee: 10,
      boostJackpotFee: 10,
      marketPlatformFee: 5,
      freeJackpotFee: 5,
    });
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

module.exports = router;
