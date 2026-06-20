const express = require('express');
const { auth, optionalAuth } = require('../middleware/auth');
const {
  getTicketBalances,
  getNftBonusesForUser,
  getNftBonusesConfigRows,
  getGoldenTicketBoostRanges,
  getGoldenTicketBoostRate,
} = require('../services/ticketService');

const router = express.Router();

function parseOptionalWalletQuery(req) {
  const raw = req.query.walletAddress != null ? String(req.query.walletAddress).trim() : '';
  return raw && /^0x[a-fA-F0-9]{40}$/.test(raw) ? [raw.toLowerCase()] : [];
}

router.get('/balances', auth, async (req, res) => {
  try {
    const additionalWallets = parseOptionalWalletQuery(req);
    const balances = await getTicketBalances(req.user._id, { additionalWallets });
    const goldenRate = await getGoldenTicketBoostRate();
    res.json({
      ...balances,
      goldenTicketBoostRate: goldenRate,
      goldenTicketBoostRanges: [],
      walletChecked: additionalWallets[0] || null,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

/** Admin NFT/FT bonus table only (no on-chain calls). */
router.get('/nft-bonuses/config', async (req, res) => {
  try {
    const nftBonuses = await getNftBonusesConfigRows();
    res.json({ nftBonuses });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/nft-bonuses', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?._id || null;
    const rawWallet = req.query.walletAddress != null ? String(req.query.walletAddress).trim() : '';
    const additionalWallets =
      userId && rawWallet && /^0x[a-fA-F0-9]{40}$/.test(rawWallet) ? [rawWallet.toLowerCase()] : [];
    const nftBonuses = await getNftBonusesForUser(userId, { additionalWallets });
    res.json({ nftBonuses, walletChecked: additionalWallets[0] || null });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** Re-verify on-chain holdings for linked + optional connected wallet (auth required). */
router.get('/verify-holdings', auth, async (req, res) => {
  try {
    const additionalWallets = parseOptionalWalletQuery(req);
    const balances = await getTicketBalances(req.user._id, { additionalWallets, forceVerify: true });
    const goldenRate = await getGoldenTicketBoostRate();
    res.json({
      ...balances,
      goldenTicketBoostRate: goldenRate,
      goldenTicketBoostRanges: [],
      walletChecked: additionalWallets[0] || null,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

module.exports = router;
