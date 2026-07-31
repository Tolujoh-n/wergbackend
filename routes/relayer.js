const express = require('express');
const { ethers } = require('ethers');
const { auth } = require('../middleware/auth');
const { createIpRateLimiter } = require('../middleware/ipRateLimit');
const { getClientIp } = require('../utils/clientIp');
const WalletLink = require('../models/WalletLink');
const User = require('../models/User');
const GasDripLog = require('../models/GasDripLog');
const { getChainId, getReadJsonRpcProvider, getWriteJsonRpcProvider } = require('../utils/chainConfig');
const {
  resolveDripAmountWei,
  cooldownMsForPlayType,
  lastDripFieldForPlayType,
  dripEligibleFromLast,
  utcDayStart,
  HARD_MAX_USD_PER_DRIP,
} = require('../services/gasDripSettings');

const router = express.Router();

const gasDripRateLimit = createIpRateLimiter({
  action: 'relayer:gasdrip',
  limit: 8,
  windowMs: 60 * 1000,
  message: 'Too many gas drip requests. Please wait a minute.',
});

const LOCK_MS = 120 * 1000;

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
  if (t.includes('boost')) return 'boost';
  if (t.includes('free') || t.includes('jackpot')) return 'free';
  return 'market';
}

async function clearUserDripLock(userId) {
  await User.updateOne({ _id: userId }, { $set: { gasDripLockUntil: null } }).catch(() => {});
}

async function clearWalletDripLock(walletLower) {
  await WalletLink.updateOne(
    { walletAddress: walletLower },
    { $set: { gasDripLockUntil: null } }
  ).catch(() => {});
}

async function getDailyUsage({ userId, walletLower }) {
  const since = utcDayStart();
  const [userLogs, walletLogs] = await Promise.all([
    GasDripLog.find({
      user: userId,
      status: 'sent',
      createdAt: { $gte: since },
    })
      .select('amountUsdApprox')
      .lean(),
    GasDripLog.find({
      walletAddress: walletLower,
      status: 'sent',
      createdAt: { $gte: since },
    })
      .select('_id')
      .lean(),
  ]);
  const userCount = userLogs.length;
  const userUsd = userLogs.reduce((s, r) => s + (Number(r.amountUsdApprox) || 0), 0);
  return {
    userCount,
    userUsd,
    walletCount: walletLogs.length,
  };
}

/**
 * Gas-drip endpoint: if user has low Base ETH, backend sends a small amount for gas.
 * Hardened: kill switch, cooldowns on ALL play types, daily caps, primary-wallet-only,
 * atomic locks (user + wallet), IP rate limit, audit log.
 */
router.post('/gasdrip', auth, gasDripRateLimit, async (req, res) => {
  const ip = getClientIp(req);
  let userLockHeld = false;
  let walletLockHeld = false;
  let addrLower = null;
  let userId = req.user?._id;

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
    addrLower = normalizeWalletAddress(checksum);

    const drip = await resolveDripAmountWei(playType);
    const { settings } = drip;

    if (!settings.enabled) {
      return res.status(503).json({
        code: 'DRIP_DISABLED',
        message: 'Gas drip is temporarily disabled. Fund a little Base ETH to continue.',
      });
    }

    if (!(drip.usd > 0) || drip.usd > HARD_MAX_USD_PER_DRIP) {
      return res.status(400).json({ message: 'Invalid drip amount configuration' });
    }

    const link = await WalletLink.findOne({ walletAddress: addrLower }).lean();
    if (!link) {
      return res.status(400).json({ message: 'Link a wallet to your account' });
    }
    if (String(link.user) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Connect the wallet linked to your profile' });
    }

    const userDoc = await User.findById(req.user._id)
      .select(
        'walletAddress lastFreeGasDripAt lastBoostGasDripAt lastMarketGasDripAt gasDripLockUntil banned'
      )
      .lean();
    if (!userDoc || userDoc.banned) {
      return res.status(403).json({ message: 'Account not eligible for gas drip' });
    }

    if (settings.primaryWalletOnly) {
      let primary = normalizeWalletAddress(userDoc.walletAddress);
      if (!primary) {
        const links = await WalletLink.find({ user: req.user._id }).select('walletAddress').lean();
        if (links.length === 1) {
          primary = normalizeWalletAddress(links[0].walletAddress);
          if (primary) {
            await User.updateOne({ _id: req.user._id }, { $set: { walletAddress: primary } });
          }
        }
      }
      if (!primary || primary !== addrLower) {
        return res.status(403).json({
          code: 'PRIMARY_WALLET_ONLY',
          message:
            'Gas drip is only available for your primary linked wallet. Set it as primary on your profile, or fund Base ETH yourself.',
        });
      }
    }

    // Play-type cooldown (user)
    const typeCooldownMs = cooldownMsForPlayType(playType, settings);
    const typeField = lastDripFieldForPlayType(playType);
    const typeGate = dripEligibleFromLast(userDoc[typeField], typeCooldownMs);
    if (!typeGate.eligible) {
      return res.status(429).json({
        code: 'DRIP_COOLDOWN',
        message: `Gas drip for ${playType} is on cooldown. Fund Base ETH or wait until you are eligible again.`,
        nextEligibleAt: typeGate.nextEligibleAt,
        remainingMs: typeGate.remainingMs,
        playType,
      });
    }

    // Any-drip cooldown (wallet)
    const walletCooldownMs =
      (Number(settings.walletCooldownHours) || 6) * 60 * 60 * 1000;
    const walletGate = dripEligibleFromLast(link.lastGasDripAt, walletCooldownMs);
    if (!walletGate.eligible) {
      return res.status(429).json({
        code: 'DRIP_COOLDOWN',
        message:
          'This wallet recently received a gas drip. Fund Base ETH or wait before requesting again.',
        nextEligibleAt: walletGate.nextEligibleAt,
        remainingMs: walletGate.remainingMs,
        playType,
      });
    }

    // Daily caps
    const usage = await getDailyUsage({ userId: req.user._id, walletLower: addrLower });
    if (usage.userCount >= settings.maxDripsPerUserPerDay) {
      return res.status(429).json({
        code: 'DRIP_DAILY_CAP',
        message: 'Daily gas drip limit reached for your account. Fund Base ETH to continue.',
        playType,
      });
    }
    if (usage.walletCount >= settings.maxDripsPerWalletPerDay) {
      return res.status(429).json({
        code: 'DRIP_DAILY_CAP',
        message: 'Daily gas drip limit reached for this wallet. Fund Base ETH to continue.',
        playType,
      });
    }
    if (usage.userUsd + drip.usd > settings.maxUsdPerUserPerDay + 1e-9) {
      return res.status(429).json({
        code: 'DRIP_DAILY_CAP',
        message: 'Daily gas drip USD limit reached. Fund Base ETH to continue.',
        playType,
      });
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

    const now = new Date();
    const lockUntil = new Date(now.getTime() + LOCK_MS);

    // Atomic user lock (prevents parallel drain)
    const userLocked = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        $or: [
          { gasDripLockUntil: { $exists: false } },
          { gasDripLockUntil: null },
          { gasDripLockUntil: { $lte: now } },
        ],
      },
      { $set: { gasDripLockUntil: lockUntil } },
      { new: true }
    );
    if (!userLocked) {
      return res.status(429).json({
        code: 'DRIP_BUSY',
        message: 'A gas drip is already in progress. Please wait a moment.',
      });
    }
    userLockHeld = true;

    // Atomic wallet lock
    const walletLocked = await WalletLink.findOneAndUpdate(
      {
        walletAddress: addrLower,
        user: req.user._id,
        $or: [
          { gasDripLockUntil: { $exists: false } },
          { gasDripLockUntil: null },
          { gasDripLockUntil: { $lte: now } },
        ],
      },
      { $set: { gasDripLockUntil: lockUntil } },
      { new: true }
    );
    if (!walletLocked) {
      await clearUserDripLock(req.user._id);
      userLockHeld = false;
      return res.status(429).json({
        code: 'DRIP_BUSY',
        message: 'A gas drip is already in progress for this wallet. Please wait.',
      });
    }
    walletLockHeld = true;

    // Re-check balance under lock (race: another drip may have landed)
    const balUnderLock = await readProvider.getBalance(checksum);
    if (balUnderLock >= drip.minBalanceWei) {
      await clearUserDripLock(req.user._id);
      await clearWalletDripLock(addrLower);
      userLockHeld = false;
      walletLockHeld = false;
      return res.json({
        ok: true,
        sent: false,
        message: 'Wallet already has sufficient gas balance',
        walletAddress: checksum,
        balanceWei: balUnderLock.toString(),
        playType,
      });
    }

    const relayer = getRelayerWallet(writeProvider);
    const relayerBal = await readProvider.getBalance(relayer.address);
    // Keep a small reserve so the relayer can still pay its own gas
    const reserveWei = ethers.parseEther('0.00005');
    if (relayerBal < drip.amountWei + reserveWei) {
      await clearUserDripLock(req.user._id);
      await clearWalletDripLock(addrLower);
      userLockHeld = false;
      walletLockHeld = false;
      return res.status(503).json({
        code: 'RELAYER_OUT_OF_GAS',
        message:
          'Relayer has no fund to drip gas. Get a little Base ETH to process transactions — they need a small amount of ETH to pay gas.',
        relayerAddress: relayer.address,
        playType,
      });
    }

    let receipt;
    try {
      const tx = await relayer.sendTransaction({
        to: checksum,
        value: drip.amountWei,
      });
      receipt = await tx.wait();
    } catch (sendErr) {
      await GasDripLog.create({
        user: req.user._id,
        walletAddress: addrLower,
        playType,
        amountWei: drip.amountWei.toString(),
        amountEth: drip.eth,
        amountUsdApprox: drip.usd,
        status: 'failed',
        reason: String(sendErr.message || sendErr).slice(0, 300),
        ip,
      }).catch(() => {});
      throw sendErr;
    }

    // Record cooldowns only after successful send
    await User.updateOne(
      { _id: req.user._id },
      {
        $set: {
          [typeField]: new Date(),
          gasDripLockUntil: null,
        },
      }
    );
    await WalletLink.updateOne(
      { walletAddress: addrLower },
      {
        $set: {
          lastGasDripAt: new Date(),
          gasDripLockUntil: null,
        },
      }
    );
    userLockHeld = false;
    walletLockHeld = false;

    await GasDripLog.create({
      user: req.user._id,
      walletAddress: addrLower,
      playType,
      amountWei: drip.amountWei.toString(),
      amountEth: drip.eth,
      amountUsdApprox: drip.usd,
      txHash: receipt.hash,
      status: 'sent',
      ip,
    });

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
    if (userLockHeld && userId) await clearUserDripLock(userId);
    if (walletLockHeld && addrLower) await clearWalletDripLock(addrLower);
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
    const { getGasDripSettings } = require('../services/gasDripSettings');
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
