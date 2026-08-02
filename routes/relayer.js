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
const { noteDripDenial, noteDripSuccess } = require('../services/abuseDetection');

const router = express.Router();

const gasDripRateLimit = createIpRateLimiter({
  action: 'relayer:gasdrip',
  limit: 3,
  windowMs: 60 * 1000,
  message: 'Too many gas drip requests. Please wait a minute.',
});

const gasDripUserRateLimit = async (req, res, next) => {
  try {
    const uid = String(req.user?._id || req.params?.userId || '');
    if (!uid) return next();
    const { consumeRateLimit } = require('../services/ipRateLimitService');
    await consumeRateLimit({
      key: `relayer:gasdrip:user:${uid}`,
      limit: 3,
      windowMs: 60 * 1000,
    });
    return next();
  } catch (e) {
    if (e.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({
        message: 'Too many gas drip requests for this account. Please wait a minute.',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: e.retryAfterSeconds,
      });
    }
    return next(e);
  }
};

const LOCK_MS = 120 * 1000;

async function denyDrip(res, req, status, body, { walletAddress } = {}) {
  const abuseCodes = new Set([
    'PRIMARY_WALLET_ONLY',
    'JACKPOT_MIN_NOT_MET',
    'ACCOUNT_TOO_NEW',
    'USER_MISMATCH',
    'DRIP_COOLDOWN',
    'DRIP_DAILY_CAP',
    'DRIP_BUSY',
    'DRIP_DISABLED',
  ]);
  if (status === 429 || abuseCodes.has(body?.code)) {
    const ban = await noteDripDenial({
      userId: req.user?._id,
      walletAddress: walletAddress || req.body?.walletAddress,
      ip: getClientIp(req),
      code: body?.code || String(status),
      meta: { playType: req.body?.playType },
    });
    if (ban?.banned) {
      return res.status(403).json({
        message: 'Your account is banned for unusual activities.',
        code: 'ACCOUNT_BANNED',
      });
    }
  }
  return res.status(status).json(body);
}

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
 * Gas-drip endpoint (user-bound): POST /relayer/users/:userId/gasdrip
 * Requires JWT for that exact userId + linked wallet + min free-jackpot balance.
 */
async function handleGasDrip(req, res) {
  const ip = getClientIp(req);
  let userLockHeld = false;
  let walletLockHeld = false;
  let addrLower = null;

  try {
    const pathUserId = String(req.params.userId || '').trim();
    const bodyUserId = String(req.body?.userId || '').trim();
    const authUserId = String(req.user?._id || '');

    if (!authUserId) {
      return res.status(401).json({ message: 'Login required', code: 'AUTH_REQUIRED' });
    }
    if (!pathUserId || pathUserId !== authUserId) {
      return res.status(403).json({
        message: 'Relayer user id does not match the logged-in account',
        code: 'USER_MISMATCH',
      });
    }
    if (bodyUserId && bodyUserId !== authUserId) {
      return res.status(403).json({
        message: 'Relayer user id does not match the logged-in account',
        code: 'USER_MISMATCH',
      });
    }

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
      return denyDrip(res, req, 503, {
        code: 'DRIP_DISABLED',
        message: 'Gas drip is temporarily disabled. Fund a little Base ETH to continue.',
      }, { walletAddress: addrLower });
    }

    if (!(drip.usd > 0) || drip.usd > HARD_MAX_USD_PER_DRIP) {
      return res.status(400).json({ message: 'Invalid drip amount configuration' });
    }

    const link = await WalletLink.findOne({ walletAddress: addrLower }).lean();
    if (!link) {
      return res.status(400).json({ message: 'Link a wallet to your account' });
    }
    if (String(link.user) !== authUserId) {
      return res.status(403).json({ message: 'Connect the wallet linked to your profile' });
    }

    const userDoc = await User.findById(authUserId)
      .select(
        'walletAddress lastFreeGasDripAt lastBoostGasDripAt lastMarketGasDripAt gasDripLockUntil banned createdAt jackpotBalance role'
      )
      .lean();
    if (!userDoc || userDoc.banned) {
      return res.status(403).json({ message: 'Account not eligible for gas drip' });
    }
    if (userDoc.role === 'admin' || userDoc.role === 'superAdmin') {
      // Admins can still drip for testing — no extra block
    }

    const minAgeMs = (Number(settings.minAccountAgeMinutes) || 0) * 60 * 1000;
    if (minAgeMs > 0 && userDoc.createdAt) {
      const age = Date.now() - new Date(userDoc.createdAt).getTime();
      if (age < minAgeMs) {
        return denyDrip(
          res,
          req,
          403,
          {
            code: 'ACCOUNT_TOO_NEW',
            message:
              'Your account is too new to use gas drip. Fund a little Base ETH, or try again later.',
            minAccountAgeMinutes: settings.minAccountAgeMinutes,
          },
          { walletAddress: addrLower }
        );
      }
    }

    const minJackpot = Number(settings.minJackpotUsdForDrip) || 0;
    if (minJackpot > 0) {
      const { sumEligibleUnclaimedJackpot } = require('../services/jackpotEligibility');
      const { total: eligibleJackpot } = await sumEligibleUnclaimedJackpot(authUserId);
      const dbBalance = Math.max(0, Number(userDoc.jackpotBalance) || 0);
      const held = Math.min(eligibleJackpot, dbBalance > 0 ? dbBalance : eligibleJackpot);
      const claimable = Math.max(eligibleJackpot, 0);
      if (claimable + 1e-9 < minJackpot) {
        return denyDrip(
          res,
          req,
          403,
          {
            code: 'JACKPOT_MIN_NOT_MET',
            message: `Gas drip requires at least $${minJackpot.toFixed(2)} claimable Free jackpot. Accumulate more wins, or fund Base ETH yourself to claim smaller amounts.`,
            minJackpotUsd: minJackpot,
            claimableJackpotUsd: Math.round(claimable * 1e6) / 1e6,
            heldJackpotUsd: Math.round(held * 1e6) / 1e6,
          },
          { walletAddress: addrLower }
        );
      }

      // If client declares a claim amount below the min, block drip (must self-fund ETH).
      const claimAmtRaw = req.body?.claimAmountUsdc;
      if (claimAmtRaw != null && claimAmtRaw !== '') {
        const claimAmt = Number(claimAmtRaw);
        if (Number.isFinite(claimAmt) && claimAmt >= 0 && claimAmt + 1e-9 < minJackpot) {
          return denyDrip(
            res,
            req,
            403,
            {
              code: 'JACKPOT_MIN_NOT_MET',
              message: `This claim is under $${minJackpot.toFixed(2)}. Fund Base ETH to claim smaller amounts, or accumulate at least $${minJackpot.toFixed(2)} Free jackpot to use platform gas drip.`,
              minJackpotUsd: minJackpot,
              claimableJackpotUsd: Math.round(claimable * 1e6) / 1e6,
              claimAmountUsdc: Math.round(claimAmt * 1e6) / 1e6,
            },
            { walletAddress: addrLower }
          );
        }
      }
    }

    if (settings.primaryWalletOnly) {
      let primary = normalizeWalletAddress(userDoc.walletAddress);
      if (!primary) {
        const links = await WalletLink.find({ user: authUserId }).select('walletAddress').lean();
        if (links.length === 1) {
          primary = normalizeWalletAddress(links[0].walletAddress);
          if (primary) {
            await User.updateOne({ _id: authUserId }, { $set: { walletAddress: primary } });
          }
        }
      }
      if (!primary || primary !== addrLower) {
        return denyDrip(
          res,
          req,
          403,
          {
            code: 'PRIMARY_WALLET_ONLY',
            message:
              'Gas drip is only available for your primary linked wallet. Set it as primary on your profile, or fund Base ETH yourself.',
          },
          { walletAddress: addrLower }
        );
      }
    }

    // Play-type cooldown (user)
    const typeCooldownMs = cooldownMsForPlayType(playType, settings);
    const typeField = lastDripFieldForPlayType(playType);
    const typeGate = dripEligibleFromLast(userDoc[typeField], typeCooldownMs);
    if (!typeGate.eligible) {
      return denyDrip(
        res,
        req,
        429,
        {
          code: 'DRIP_COOLDOWN',
          message: `Gas drip for ${playType} is on cooldown. Fund Base ETH or wait until you are eligible again.`,
          nextEligibleAt: typeGate.nextEligibleAt,
          remainingMs: typeGate.remainingMs,
          playType,
        },
        { walletAddress: addrLower }
      );
    }

    // Any-drip cooldown (wallet)
    const walletCooldownMs =
      (Number(settings.walletCooldownHours) || 24) * 60 * 60 * 1000;
    const walletGate = dripEligibleFromLast(link.lastGasDripAt, walletCooldownMs);
    if (!walletGate.eligible) {
      return denyDrip(
        res,
        req,
        429,
        {
          code: 'DRIP_COOLDOWN',
          message:
            'This wallet recently received a gas drip. Fund Base ETH or wait before requesting again.',
          nextEligibleAt: walletGate.nextEligibleAt,
          remainingMs: walletGate.remainingMs,
          playType,
        },
        { walletAddress: addrLower }
      );
    }

    // Daily caps
    const usage = await getDailyUsage({ userId: authUserId, walletLower: addrLower });
    if (usage.userCount >= settings.maxDripsPerUserPerDay) {
      return denyDrip(
        res,
        req,
        429,
        {
          code: 'DRIP_DAILY_CAP',
          message: 'Daily gas drip limit reached for your account. Fund Base ETH to continue.',
          playType,
        },
        { walletAddress: addrLower }
      );
    }
    if (usage.walletCount >= settings.maxDripsPerWalletPerDay) {
      return denyDrip(
        res,
        req,
        429,
        {
          code: 'DRIP_DAILY_CAP',
          message: 'Daily gas drip limit reached for this wallet. Fund Base ETH to continue.',
          playType,
        },
        { walletAddress: addrLower }
      );
    }
    if (usage.userUsd + drip.usd > settings.maxUsdPerUserPerDay + 1e-9) {
      return denyDrip(
        res,
        req,
        429,
        {
          code: 'DRIP_DAILY_CAP',
          message: 'Daily gas drip USD limit reached. Fund Base ETH to continue.',
          playType,
        },
        { walletAddress: addrLower }
      );
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
        userId: authUserId,
        balanceWei: currentBal.toString(),
        playType,
      });
    }

    const now = new Date();
    const lockUntil = new Date(now.getTime() + LOCK_MS);

    const userLocked = await User.findOneAndUpdate(
      {
        _id: authUserId,
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

    const walletLocked = await WalletLink.findOneAndUpdate(
      {
        walletAddress: addrLower,
        user: authUserId,
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
      await clearUserDripLock(authUserId);
      userLockHeld = false;
      return res.status(429).json({
        code: 'DRIP_BUSY',
        message: 'A gas drip is already in progress for this wallet. Please wait.',
      });
    }
    walletLockHeld = true;

    const balUnderLock = await readProvider.getBalance(checksum);
    if (balUnderLock >= drip.minBalanceWei) {
      await clearUserDripLock(authUserId);
      await clearWalletDripLock(addrLower);
      userLockHeld = false;
      walletLockHeld = false;
      return res.json({
        ok: true,
        sent: false,
        message: 'Wallet already has sufficient gas balance',
        walletAddress: checksum,
        userId: authUserId,
        balanceWei: balUnderLock.toString(),
        playType,
      });
    }

    const relayer = getRelayerWallet(writeProvider);
    const relayerBal = await readProvider.getBalance(relayer.address);
    const reserveWei = ethers.parseEther('0.00005');
    if (relayerBal < drip.amountWei + reserveWei) {
      await clearUserDripLock(authUserId);
      await clearWalletDripLock(addrLower);
      userLockHeld = false;
      walletLockHeld = false;
      return res.status(503).json({
        code: 'RELAYER_OUT_OF_GAS',
        message:
          'Relayer has no fund to drip gas. Get a little Base ETH to process transactions — they need a small amount of ETH to pay gas.',
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
        user: authUserId,
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

    await User.updateOne(
      { _id: authUserId },
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
      user: authUserId,
      walletAddress: addrLower,
      playType,
      amountWei: drip.amountWei.toString(),
      amountEth: drip.eth,
      amountUsdApprox: drip.usd,
      txHash: receipt.hash,
      status: 'sent',
      ip,
    });

    await noteDripSuccess({
      userId: authUserId,
      walletAddress: addrLower,
      ip,
      meta: { playType, txHash: receipt.hash, usd: drip.usd },
    });

    return res.json({
      ok: true,
      sent: true,
      txHash: receipt.hash,
      walletAddress: checksum,
      userId: authUserId,
      amountWei: drip.amountWei.toString(),
      amountEth: drip.eth,
      amountUsd: drip.usd,
      playType,
    });
  } catch (error) {
    if (userLockHeld && req.user?._id) await clearUserDripLock(req.user._id);
    if (walletLockHeld && addrLower) await clearWalletDripLock(addrLower);
    console.error('gasdrip:', error);
    const code = error.statusCode || 500;
    res.status(code).json({ message: error.message || 'Gasdrip failed' });
  }
}

/** Legacy path — disabled (must use user-bound URL). */
router.post('/gasdrip', auth, (req, res) => {
  res.status(410).json({
    code: 'RELAYER_PATH_DEPRECATED',
    message:
      'Use POST /api/relayer/users/:userId/gasdrip with your logged-in user id. Legacy /gasdrip is disabled.',
  });
});

router.post(
  '/users/:userId/gasdrip',
  auth,
  gasDripRateLimit,
  gasDripUserRateLimit,
  handleGasDrip
);

router.get('/users/:userId/status', auth, async (req, res) => {
  try {
    const pathUserId = String(req.params.userId || '').trim();
    const authUserId = String(req.user?._id || '');
    if (!pathUserId || pathUserId !== authUserId) {
      return res.status(403).json({ message: 'User mismatch', code: 'USER_MISMATCH' });
    }
    const { getGasDripSettings } = require('../services/gasDripSettings');
    const { sumEligibleUnclaimedJackpot } = require('../services/jackpotEligibility');
    const settings = await getGasDripSettings();
    const { total: claimableJackpotUsd } = await sumEligibleUnclaimedJackpot(authUserId);
    const minJackpotUsd = Number(settings.minJackpotUsdForDrip) || 0;
    res.json({
      userId: authUserId,
      enabled: settings.enabled,
      primaryWalletOnly: settings.primaryWalletOnly,
      minJackpotUsdForDrip: minJackpotUsd,
      minAccountAgeMinutes: settings.minAccountAgeMinutes,
      claimableJackpotUsd: Math.round(claimableJackpotUsd * 1e6) / 1e6,
      dripEligibleByJackpot: claimableJackpotUsd + 1e-9 >= minJackpotUsd,
    });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ message: error.message || 'Relayer status failed' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const { getGasDripSettings } = require('../services/gasDripSettings');
    const settings = await getGasDripSettings();
    res.json({
      enabled: settings.enabled,
      primaryWalletOnly: settings.primaryWalletOnly,
      minJackpotUsdForDrip: settings.minJackpotUsdForDrip,
      usePath: `/api/relayer/users/${req.user._id}/gasdrip`,
    });
  } catch (error) {
    const code = error.statusCode || 500;
    res.status(code).json({ message: error.message || 'Relayer status failed' });
  }
});

module.exports = router;
