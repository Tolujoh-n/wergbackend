const express = require('express');
const Settings = require('../models/Settings');
const Cup = require('../models/Cup');

const router = express.Router();

function parseHomeLandingEnabled(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  // Default off so existing sites keep first navbar cup (e.g. World Cup) as landing.
  return false;
}

// Public landing config: Home hub vs first navbar cup
router.get('/landing', async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'homeLandingEnabled' }).lean();
    const homeLandingEnabled = parseHomeLandingEnabled(setting?.value);

    const firstNavbarCup = await Cup.findOne({ showInNavbar: true })
      .sort({ navbarOrder: 1, createdAt: -1 })
      .select('name slug')
      .lean();

    res.json({
      homeLandingEnabled,
      defaultCupSlug: firstNavbarCup?.slug || 'worldcup',
      defaultCupName: firstNavbarCup?.name || null,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get social media links (public route)
router.get('/social-links', async (req, res) => {
  try {
    const socialKeys = ['socialTwitter', 'socialFacebook', 'socialInstagram', 'socialYoutube'];
    const socialLinks = {};
    
    for (const key of socialKeys) {
      const setting = await Settings.findOne({ key });
      socialLinks[key] = setting ? setting.value : '';
    }
    
    res.json(socialLinks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
