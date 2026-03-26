const express = require('express');
const EthPrice = require('../models/EthPrice');

const router = express.Router();

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';

// GET latest ETH price (from DB)
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
    const ethPrice = data?.ethereum?.usd;
    if (typeof ethPrice !== 'number' || Number.isNaN(ethPrice)) {
      throw new Error('Invalid price in CoinGecko response');
    }

    await EthPrice.findOneAndUpdate(
      {},
      { usd: ethPrice, lastUpdated: new Date() },
      { upsert: true, new: true }
    );

    console.log('ETH price updated:', ethPrice);
  } catch (err) {
    console.error('Error updating ETH price:', err.message);
  }
}

module.exports = { router, updateEthPrice };
