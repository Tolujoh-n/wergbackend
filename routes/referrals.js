const express = require('express');
const { auth, optionalAuth } = require('../middleware/auth');
const {
  getReferralDashboard,
  validateReferralCodePublic,
  normalizeReferralCode,
} = require('../services/referralService');

const router = express.Router();

/** Logged-in user: link, stats, referred users table */
router.get('/me', auth, async (req, res) => {
  try {
    const data = await getReferralDashboard(req.user._id);
    const base =
      process.env.FRONTEND_URL ||
      process.env.REACT_APP_FRONTEND_URL ||
      process.env.CLIENT_URL ||
      '';
    const origin = String(base).replace(/\/$/, '');
    data.referralLink = origin
      ? `${origin}/?ref=${encodeURIComponent(data.referralCode)}`
      : `/?ref=${encodeURIComponent(data.referralCode)}`;
    res.json(data);
  } catch (error) {
    console.error('referrals/me:', error);
    res.status(500).json({ message: error.message || 'Failed to load referral data' });
  }
});

/** Public: check if a referral code is valid (signup preview) */
router.get('/validate/:code', optionalAuth, async (req, res) => {
  try {
    const result = await validateReferralCodePublic(req.params.code);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

/** Normalize helper for frontend */
router.get('/normalize', (req, res) => {
  const code = normalizeReferralCode(req.query.code || '');
  res.json({ code: code || null });
});

module.exports = router;
