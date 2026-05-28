const express = require('express');
const EthPrice = require('../models/EthPrice');

const router = express.Router();

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd';

// GET latest USDC price (from DB) — legacy route name kept for backwards compatibility
router.get('/eth', async (req, res) => {
  try {
    const priceDoc = await EthPrice.findOne({});
    if (!priceDoc) {
      return res.status(404).json({ error: 'ETH price not available yet; wait for next sync' });
    }

    res.json({
      usd: priceDoc.usd,
      lastUpdated: priceDoc.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Alias for simple clients
router.get('/', async (req, res) => {
  try {
    const priceDoc = await EthPrice.findOne({});
    if (!priceDoc) {
      return res.status(404).json({ error: 'ETH price not available yet; wait for next sync' });
    }

    res.json({
      usd: priceDoc.usd,
      lastUpdated: priceDoc.lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

async function updateEthPrice() {
  try {
    const response = await fetch(COINGECKO_URL);
    if (!response.ok) {
      throw new Error(`CoinGecko HTTP ${response.status}`);
    }
    const data = await response.json();
    const usdcPrice = data?.['usd-coin']?.usd;
    if (typeof usdcPrice !== 'number' || Number.isNaN(usdcPrice)) {
      throw new Error('Invalid price in CoinGecko response');
    }

    await EthPrice.findOneAndUpdate(
      {},
      { usd: usdcPrice, lastUpdated: new Date() },
      { upsert: true, new: true }
    );

    console.log('USDC price updated:', usdcPrice);
  } catch (err) {
    console.error('Error updating USDC price:', err.message);
  }
}

module.exports = { router, updateEthPrice };
