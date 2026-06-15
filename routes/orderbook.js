const express = require('express');
const { ethers } = require('ethers');
const { auth } = require('../middleware/auth');
const Order = require('../models/Order');
const OrderbookPosition = require('../models/OrderbookPosition');
const {
  placeOrder,
  cancelOrder,
  getBook,
  readVaultBalance,
  reservedCollateralForWallet,
  getOrderbookDefaults,
  getFees,
  positionKey,
  getOrderbookMarketActivity,
  getMarketSnapshot,
  impliedProbabilityByOption,
} = require('../services/orderbookService');
const { getUserTradingPanel } = require('../services/orderbookTradingPanel');
const { signTradingVaultWithdrawPayload, getClaimSignerAddress } = require('../utils/claimAuth');
const { getContractAddress, getChainId } = require('../utils/chainConfig');
const { withOrderbookContract } = require('../utils/orderbookContractScope');
const {
  resolveOrderbookUserScope,
  withOrderbookContractForUser,
  withOrderbookContractOrLegacyForUser,
} = require('../utils/orderbookUserScope');
const WalletLink = require('../models/WalletLink');

const router = express.Router();

function normWallet(addr) {
  try {
    return ethers.getAddress(String(addr).trim());
  } catch {
    return null;
  }
}

router.get('/defaults', async (req, res) => {
  try {
    const defaults = await getOrderbookDefaults();
    const fees = await getFees();
    const takerFeeRate = (fees.marketPlatformFee + fees.freeJackpotFee) / 100;
    res.json({ ...defaults, takerFeeRate });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/vault', auth, async (req, res) => {
  try {
    const w = normWallet(req.query.walletAddress);
    if (!w) return res.status(400).json({ message: 'walletAddress required' });
    const wl = w.toLowerCase();
    const link = await WalletLink.findOne({ walletAddress: wl, user: req.user._id }).lean();
    if (!link) {
      return res.status(403).json({
        message: 'Wallet not linked to your account. Connect and link this wallet on the Wallet page first.',
        code: 'WALLET_NOT_LINKED',
      });
    }
    const [vault, reserved] = await Promise.all([readVaultBalance(w), reservedCollateralForWallet(wl)]);
    res.json({
      walletAddress: w,
      onChainVaultUsdc: vault,
      reservedUsdc: reserved,
      availableUsdc: Math.max(0, vault - reserved),
      contractAddress: getContractAddress(),
      walletLinked: true,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.post('/vault/withdraw-auth', auth, async (req, res) => {
  try {
    const { walletAddress, amountUsdc } = req.body || {};
    const w = normWallet(walletAddress);
    if (!w) return res.status(400).json({ message: 'Invalid walletAddress' });
    const amt = parseFloat(amountUsdc);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: 'Invalid amountUsdc' });
    }
    const wl = w.toLowerCase();
    const [vault, reserved] = await Promise.all([readVaultBalance(w), reservedCollateralForWallet(wl)]);
    const maxOut = Math.max(0, vault - reserved);
    if (amt > maxOut + 1e-9) {
      return res.status(400).json({ message: 'Amount exceeds withdrawable vault balance' });
    }
    const contractAddress = getContractAddress();
    if (!contractAddress) {
      return res.status(503).json({ message: 'CONTRACT_ADDRESS not configured' });
    }
    const chainId = getChainId();
    const amountWei = ethers.parseUnits(amt.toFixed(6), 6);
    const deadlineSec = Math.floor(Date.now() / 1000) + 30 * 60;
    const nonce = ethers.randomBytes(32);

    const { signature } = await signTradingVaultWithdrawPayload({
      userAddress: w,
      amountWei,
      nonce,
      deadlineSec,
      chainId,
      contractAddress,
    });

    res.json({
      claimSignerAddress: getClaimSignerAddress(),
      contractAddress,
      chainId,
      amountWei: amountWei.toString(),
      nonce: ethers.hexlify(nonce),
      deadline: deadlineSec,
      signature,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.post('/orders', auth, async (req, res) => {
  try {
    const {
      walletAddress,
      matchId,
      pollId,
      optionKey,
      side,
      direction,
      orderKind,
      limitPrice,
      size,
      slippageBps,
      expiresAt,
    } = req.body || {};

    const order = await placeOrder({
      userId: req.user._id,
      walletAddress,
      matchId,
      pollId,
      optionKey,
      side,
      direction,
      orderKind: orderKind || 'limit',
      limitPrice,
      size,
      slippageBps,
      expiresAt,
      isMarketMaker: false,
    });
    res.status(201).json(order);
  } catch (e) {
    const code = e.statusCode || 500;
    const body = { message: e.message || 'Error' };
    if (e.code) body.code = e.code;
    if (e.details) body.details = e.details;
    res.status(code).json(body);
  }
});

router.delete('/orders/:id', auth, async (req, res) => {
  try {
    const o = await cancelOrder(req.params.id, req.user._id);
    res.json(o);
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ message: e.message });
  }
});

router.get('/trading-panel/mine', auth, async (req, res) => {
  try {
    const chainMarketId = req.query.chainMarketId != null ? parseInt(req.query.chainMarketId, 10) : null;
    if (!Number.isFinite(chainMarketId)) {
      return res.status(400).json({ message: 'chainMarketId query param required' });
    }
    const panel = await getUserTradingPanel(req.user._id, chainMarketId);
    res.json(panel);
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ message: e.message });
  }
});

router.get('/orders/mine', auth, async (req, res) => {
  try {
    const chainMarketId =
      req.query.chainMarketId != null ? parseInt(req.query.chainMarketId, 10) : null;
    const scope = await resolveOrderbookUserScope(req.user._id);
    const filter = withOrderbookContractOrLegacyForUser(scope, {});
    if (Number.isFinite(chainMarketId)) filter.chainMarketId = chainMarketId;

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('match', 'teamA teamB date status isResolved result')
      .populate('poll', 'question status isResolved result optionType')
      .lean();
    res.json(orders);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/positions/mine', auth, async (req, res) => {
  try {
    const chainMarketId = req.query.chainMarketId != null ? parseInt(req.query.chainMarketId, 10) : null;
    if (!Number.isFinite(chainMarketId)) {
      return res.status(400).json({ message: 'chainMarketId query param required' });
    }

    const { withOrderbookContractOrLegacy } = require('../utils/orderbookContractScope');
    const rows = await OrderbookPosition.find(
      withOrderbookContractOrLegacy({
        user: req.user._id,
        chainMarketId,
        shares: { $gt: 1e-9 },
      })
    )
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/positions/mine/all', auth, async (req, res) => {
  try {
    const scope = await resolveOrderbookUserScope(req.user._id);
    const rows = await OrderbookPosition.find(
      withOrderbookContractForUser(scope, {
        shares: { $gt: 1e-9 },
      })
    )
      .sort({ updatedAt: -1 })
      .populate('match', 'teamA teamB date status isResolved result')
      .populate('poll', 'question status isResolved result optionType')
      .lean();
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/market/:chainMarketId/snapshot', async (req, res) => {
  try {
    const chainMarketId = parseInt(req.params.chainMarketId, 10);
    if (!Number.isFinite(chainMarketId)) {
      return res.status(400).json({ message: 'Invalid chainMarketId' });
    }
    let optionKeys = [];
    let startingPrices = [];
    const keysParam = req.query.optionKeys;
    if (keysParam) {
      optionKeys = String(keysParam)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    }
    if (req.query.startingPrices) {
      try {
        startingPrices = JSON.parse(req.query.startingPrices);
      } catch {
        startingPrices = [];
      }
    }
    const snapshot = await getMarketSnapshot(chainMarketId, optionKeys, startingPrices);
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/market/:chainMarketId/activity', async (req, res) => {
  try {
    const chainMarketId = parseInt(req.params.chainMarketId, 10);
    if (!Number.isFinite(chainMarketId)) {
      return res.status(400).json({ message: 'Invalid chainMarketId' });
    }
    let optionKeys = [];
    let startingPrices = [];
    const keysParam = req.query.optionKeys;
    if (keysParam) {
      optionKeys = String(keysParam)
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
    }
    if (req.query.startingPrices) {
      try {
        startingPrices = JSON.parse(req.query.startingPrices);
      } catch {
        startingPrices = [];
      }
    }
    const activity = await getOrderbookMarketActivity(chainMarketId, optionKeys, startingPrices);
    res.json(activity);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** Batch implied win % per option (same logic as market detail / activity chart). */
router.post('/implied/batch', async (req, res) => {
  try {
    const markets = Array.isArray(req.body?.markets) ? req.body.markets.slice(0, 80) : [];
    const byMarketId = {};
    await Promise.all(
      markets.map(async (m) => {
        const chainMarketId = parseInt(m.marketId, 10);
        if (!Number.isFinite(chainMarketId)) return;
        const optionKeys = Array.isArray(m.optionKeys)
          ? m.optionKeys.map((k) => String(k).trim()).filter(Boolean)
          : [];
        if (!optionKeys.length) return;
        const startingPrices = Array.isArray(m.startingPrices) ? m.startingPrices : [];
        try {
          byMarketId[String(chainMarketId)] = await impliedProbabilityByOption(
            chainMarketId,
            optionKeys,
            startingPrices
          );
        } catch {
          byMarketId[String(chainMarketId)] = {};
        }
      })
    );
    res.json({ byMarketId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/book/:chainMarketId', async (req, res) => {
  try {
    const chainMarketId = parseInt(req.params.chainMarketId, 10);
    const { optionKey, side } = req.query;
    if (!optionKey || !side) {
      return res.status(400).json({ message: 'optionKey and side query params required' });
    }
    const book = await getBook(chainMarketId, String(optionKey), String(side).toUpperCase());
    res.json(book);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.get('/position-key', (req, res) => {
  const { optionKey, side } = req.query;
  if (!optionKey || !side) {
    return res.status(400).json({ message: 'optionKey and side required' });
  }
  res.json({ positionKey: positionKey(String(optionKey), String(side).toUpperCase()) });
});

module.exports = router;
