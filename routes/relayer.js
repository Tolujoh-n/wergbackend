const express = require('express');
const { ethers } = require('ethers');
const { auth } = require('../middleware/auth');
const WalletLink = require('../models/WalletLink');
const User = require('../models/User');
const { getChainId, getReadJsonRpcProvider, getWriteJsonRpcProvider } = require('../utils/chainConfig');
const {
  resolveDripAmountWei,
  freeDripEligible,
  getGasDripSettings,
} = require('../services/gasDripSettings');

const router = express.Router();

function normalizeWalletAddress(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (!s) return null;
  return s.toLowerCase();
}

function getRelayerWallet(provider) {
  const pk = process.env.RELAYER_PRIVATE_KEY || process.env.GASDRIP_PRIVATE_KEY;
  if (pk && String(pk).trim()) {
    return new ethers.Wallet(String(pk).trim(), provider);
  }

  const mnemonic =
    process.env.RELAYER_MNEMONIC ||
    process.env.GASDRIP_MNEMONIC ||
    process.env.MNEMONIC;
  if (!mnemonic || !String(mnemonic).trim()) {
    const err = new Error(
      'Relayer not configured (set RELAYER_PRIVATE_KEY, or RELAYER_MNEMONIC/MNEMONIC on the server)'
    );
    err.statusCode = 503;
    throw err;
  }

  const derivationPath =
    process.env.RELAYER_DERIVATION_PATH ||
    process.env.GASDRIP_DERIVATION_PATH ||
    "m/44'/60'/0'/0/0";

  try {
    return ethers.Wallet.fromPhrase(String(mnemonic).trim().replace(/^"|"$/g, ''), provider, derivationPath);
  } catch (e) {
    const err = new Error('Invalid relayer mnemonic/derivation path configuration');
    err.statusCode = 503;
    throw err;
  }
}

function normalizePlayType(raw) {
  const t = String(raw || 'market').toLowerCase().trim();
  if (t === 'free' || t === 'boost' || t === 'market') return t;
  // Legacy labels from frontend
  if (t.includes('boost')) return 'boost';
  if (t.includes('free') || t.includes('jackpot')) return 'free';
  return 'market';
}

/**
 * Gas-drip endpoint: if user has low Base ETH, backend sends a small amount for gas.
 * Body: { walletAddress, playType?: 'free'|'boost'|'market' }
 */
router.post('/gasdrip', auth, async (req, res) => {
  try {
    const { walletAddress } = req.body || {};
    const playType = normalizePlayType(req.body?.playType || req.body?.label);
    if (!walletAddress) {
      return res.status(400).json({ message: 'walletAddress is required' });
    }

    let checksum;
    try {
      checksum = ethers.getAddress(walletAddress);
    } catch {
      return res.status(400).json({ message: 'Invalid walletAddress' });
    }
    const addrLower = normalizeWalletAddress(checksum);

    const link = await WalletLink.findOne({ walletAddress: addrLower }).lean();
    if (!link) {
      return res.status(400).json({ message: 'Link a wallet to your account' });
    }
    if (String(link.user) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Connect the wallet linked to your profile' });
    }

    const readProvider = getReadJsonRpcProvider();
    const writeProvider = getWriteJsonRpcProvider();
    try {
      const net = await readProvider.getNetwork();
      const expected = BigInt(getChainId());
      if (net.chainId !== expected) {
        return res.status(503).json({
          message: `Relayer RPC chain mismatch (expected chainId ${expected}, got ${net.chainId})`,
        });
      }
    } catch (_) {
      /* ignore */
    }

    const drip = await resolveDripAmountWei(playType);
    const user = await User.findById(req.user._id).select('lastFreeGasDripAt').lean();

    if (playType === 'free') {
      const gate = freeDripEligible(user, drip.settings);
      if (!gate.eligible) {
        return res.status(429).json({
          code: 'FREE_DRIP_COOLDOWN',
          message:
            'You have used your free gas drip for this period. Fund a little Base ETH to continue, or wait until you are eligible again.',
          nextEligibleAt: gate.nextEligibleAt,
          remainingMs: gate.remainingMs,
          freeCooldownDays: drip.settings.freeCooldownDays,
          playType,
        });
      }
    }

    const currentBal = await readProvider.getBalance(checksum);
    if (currentBal >= drip.minBalanceWei) {
      return res.json({
        ok: true,
        sent: false,
        message: 'Wallet already has sufficient gas balance',
        walletAddress: checksum,
        balanceWei: currentBal.toString(),
        playType,
      });
    }

    const relayer = getRelayerWallet(writeProvider);
    const relayerBal = await readProvider.getBalance(relayer.address);
    if (relayerBal < drip.amountWei) {
      return res.status(503).json({
        code: 'RELAYER_OUT_OF_GAS',
        message:
          'Relayer has no fund to drip gas. Get a little Base ETH to process transactions — they need a small amount of ETH to pay gas.',
        relayerAddress: relayer.address,
        playType,
      });
    }

    const tx = await relayer.sendTransaction({
      to: checksum,
      value: drip.amountWei,
    });
    const receipt = await tx.wait();

    if (playType === 'free') {
      await User.updateOne(
        { _id: req.user._id },
        { $set: { lastFreeGasDripAt: new Date() } }
      );
    }

    return res.json({
      ok: true,
      sent: true,
      txHash: receipt.hash,
      walletAddress: checksum,
      amountWei: drip.amountWei.toString(),
      amountEth: drip.eth,
      amountUsdApprox: drip.usd,
      playType,
    });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ message: error.message || 'Gasdrip failed' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const readProvider = getReadJsonRpcProvider();
    const writeProvider = getWriteJsonRpcProvider();
    const relayer = getRelayerWallet(writeProvider);
    const bal = await readProvider.getBalance(relayer.address);
    const settings = await getGasDripSettings();
    const drip = await resolveDripAmountWei('market');
    res.json({
      relayerAddress: relayer.address,
      balanceWei: bal.toString(),
      balanceEth: ethers.formatEther(bal),
      settings,
      sampleMarketDripEth: drip.eth,
      ethUsd: drip.ethUsd,
    });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ message: error.message || 'Relayer status failed' });
  }
});

module.exports = router;
