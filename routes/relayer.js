const express = require('express');
const { ethers } = require('ethers');
const { auth } = require('../middleware/auth');
const WalletLink = require('../models/WalletLink');
const { getRpcUrl, getChainId, getJsonRpcProvider } = require('../utils/chainConfig');

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

  // Fallback to mnemonic-based relayer (useful in dev/test)
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
    // ethers v6
    return ethers.Wallet.fromPhrase(String(mnemonic).trim().replace(/^"|"$/g, ''), provider, derivationPath);
  } catch (e) {
    const err = new Error('Invalid relayer mnemonic/derivation path configuration');
    err.statusCode = 503;
    throw err;
  }
}

function getGasDripConfig() {
  const minBalanceEth = Number(process.env.GASDRIP_MIN_BALANCE_ETH || '0.00005');
  const sendAmountEth = Number(process.env.GASDRIP_SEND_AMOUNT_ETH || '0.0002');
  return {
    minBalanceWei: ethers.parseEther(String(minBalanceEth)),
    sendAmountWei: ethers.parseEther(String(sendAmountEth)),
  };
}

/**
 * Gas-drip endpoint: if user has low Base ETH, backend sends a small amount for gas.
 * Requires auth and a wallet linked to the user.
 */
router.post('/gasdrip', auth, async (req, res) => {
  try {
    const { walletAddress } = req.body || {};
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

    const provider = getJsonRpcProvider();
    // sanity check network to avoid dripping on wrong chain
    try {
      const net = await provider.getNetwork();
      const expected = BigInt(getChainId());
      if (net.chainId !== expected) {
        return res.status(503).json({
          message: `Relayer RPC chain mismatch (expected chainId ${expected}, got ${net.chainId})`,
        });
      }
    } catch (_) {
      // ignore; continue
    }
    const { minBalanceWei, sendAmountWei } = getGasDripConfig();

    const currentBal = await provider.getBalance(checksum);
    if (currentBal >= minBalanceWei) {
      return res.json({
        ok: true,
        sent: false,
        message: 'Wallet already has sufficient gas balance',
        walletAddress: checksum,
        balanceWei: currentBal.toString(),
      });
    }

    const relayer = getRelayerWallet(provider);
    const relayerBal = await provider.getBalance(relayer.address);
    if (relayerBal < sendAmountWei) {
      return res.status(503).json({
        message: 'Relayer has insufficient balance to drip gas',
        relayerAddress: relayer.address,
      });
    }

    const tx = await relayer.sendTransaction({
      to: checksum,
      value: sendAmountWei,
    });
    const receipt = await tx.wait();

    return res.json({
      ok: true,
      sent: true,
      txHash: receipt.hash,
      walletAddress: checksum,
      amountWei: sendAmountWei.toString(),
    });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ message: error.message || 'Gasdrip failed' });
  }
});

// Debug/status endpoint (authenticated) to quickly see if relayer is configured
router.get('/status', auth, async (req, res) => {
  try {
    const provider = getJsonRpcProvider();
    const relayer = getRelayerWallet(provider);
    const bal = await provider.getBalance(relayer.address);
    const { minBalanceWei, sendAmountWei } = getGasDripConfig();
    res.json({
      ok: true,
      rpcUrl: getRpcUrl(),
      relayerAddress: relayer.address,
      relayerBalanceWei: bal.toString(),
      relayerBalanceEth: ethers.formatEther(bal),
      minBalanceWei: minBalanceWei.toString(),
      sendAmountWei: sendAmountWei.toString(),
    });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ ok: false, message: error.message || 'Relayer status failed' });
  }
});

module.exports = router;

