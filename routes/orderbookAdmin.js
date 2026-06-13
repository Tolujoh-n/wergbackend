const express = require('express');
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const { auth, isAdmin } = require('../middleware/auth');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const Settings = require('../models/Settings');
const SettlementOutbox = require('../models/SettlementOutbox');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const {
  getOrderbookDefaults,
  readVaultBalance,
  reservedCollateralForWallet,
  pendingVaultDebitForWallet,
  openBuyOrderReservedUsd,
} = require('../services/orderbookService');
const { runMatchMmTick, runPollMmTick, scheduleMarketMakerSeed, scheduleForceRequoteMarketMm } = require('../services/marketMakerQuotes');
const { normalizeStartingPricesRows } = require('../utils/targetOdds');
const { withOrderbookContract } = require('../utils/orderbookContractScope');

const router = express.Router();
router.use(auth);
router.use(isAdmin);

/** Bot-managed orderbook keys — never accept from admin PUT (risk + MM latch + tick clock). */
function sanitizeAdminOrderbookBody(body) {
  const b = { ...(body || {}) };
  delete b.riskPausedMarket;
  delete b.riskPausedYes;
  delete b.riskPausedNo;
  delete b.mmWidenActiveYes;
  delete b.mmWidenActiveNo;
  delete b.botLastTickAt;
  delete b.startingPrices;
  if (Array.isArray(b.pauseByOption)) {
    b.pauseByOption = b.pauseByOption.map((row) => ({
      optionKey: String(row?.optionKey || '').trim(),
      pauseYes: !!row?.pauseYes,
      pauseNo: !!row?.pauseNo,
    })).filter((row) => row.optionKey);
  }
  return b;
}

function normalizeStartingPrices(rows) {
  if (!Array.isArray(rows)) return null;
  try {
    return normalizeStartingPricesRows(rows);
  } catch (e) {
    if (e.statusCode) throw e;
    return null;
  }
}

function startingPricesChanged(before, after) {
  return JSON.stringify(before || []) !== JSON.stringify(after || []);
}

async function applyAdminMarketUpdate(doc, kind, body) {
  const startingPrices = normalizeStartingPrices(body?.startingPrices);
  const orderbookBody = { ...(body || {}) };
  delete orderbookBody.startingPrices;

  const prevPrices = doc.startingPrices || [];
  doc.orderbook = { ...(doc.orderbook || {}), ...sanitizeAdminOrderbookBody(orderbookBody) };
  if (startingPrices) {
    doc.startingPrices = startingPrices;
  }
  await doc.save();

  if (!doc.marketId) {
    return { pricesChanged: false };
  }

  const pricesChanged = startingPrices ? startingPricesChanged(prevPrices, startingPrices) : false;
  if (pricesChanged) {
    scheduleForceRequoteMarketMm({ kind, id: doc._id });
  } else {
    scheduleMarketMakerSeed({ kind, id: doc._id });
  }
  return { pricesChanged };
}

router.get('/defaults', async (req, res) => {
  try {
    const d = await getOrderbookDefaults();
    res.json(d);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.put('/defaults', async (req, res) => {
  try {
    await Settings.findOneAndUpdate(
      { key: 'orderbookDefaults' },
      { key: 'orderbookDefaults', value: req.body || {}, description: 'Global orderbook / MM defaults' },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

function normalizeWallet(addr) {
  try {
    return ethers.getAddress(String(addr || '').trim());
  } catch {
    return null;
  }
}

async function getMmActorFromSettings() {
  const sWallet = await Settings.findOne({ key: 'marketMakerWalletAddress' }).lean();
  const wallet = normalizeWallet(sWallet?.value);
  const sUserId = await Settings.findOne({ key: 'marketMakerUserId' }).lean();
  const userId = sUserId?.value ? String(sUserId.value) : null;
  return { walletAddress: wallet, userId };
}

async function ensureBotUserAndLink(walletAddress) {
  const walletLower = String(walletAddress).toLowerCase();

  // Ensure there's a dedicated bot user
  let bot = await User.findOne({ username: 'market-maker-bot' });
  if (!bot) {
    bot = new User({
      username: 'market-maker-bot',
      email: 'market-maker-bot@internal',
      role: 'admin', // admin is fine; bot uses API, not JWT sessions
    });
    await bot.save();
  }

  // Enforce wallet uniqueness across users
  const existing = await WalletLink.findOne({ walletAddress: walletLower }).lean();
  if (existing && String(existing.user) !== String(bot._id)) {
    const err = new Error('That wallet is already linked to another user account');
    err.statusCode = 409;
    throw err;
  }

  await WalletLink.findOneAndUpdate(
    { walletAddress: walletLower },
    { $set: { walletAddress: walletLower, user: bot._id } },
    { upsert: true, new: true }
  );

  // Keep legacy field aligned when possible (not required for orderbook)
  if (!bot.walletAddress) {
    bot.walletAddress = walletAddress;
    await bot.save().catch(() => {});
  }

  await Settings.findOneAndUpdate(
    { key: 'marketMakerUserId' },
    { key: 'marketMakerUserId', value: String(bot._id), description: 'Internal MM bot user id' },
    { upsert: true }
  );

  return bot;
}

router.get('/mm-actor', async (req, res) => {
  try {
    const s = await getMmActorFromSettings();
    res.json({
      walletAddress: s.walletAddress,
      userId: s.userId,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** On-chain vault + reserve breakdown for the MM bot wallet (admin troubleshooting). */
router.get('/mm-vault', async (req, res) => {
  try {
    const s = await getMmActorFromSettings();
    if (!s.walletAddress) {
      return res.status(400).json({ message: 'Market maker wallet not configured' });
    }
    const wl = String(s.walletAddress).toLowerCase();
    const [vault, reserved, pendingSettle, openBuyReserve] = await Promise.all([
      readVaultBalance(s.walletAddress),
      reservedCollateralForWallet(wl),
      pendingVaultDebitForWallet(wl),
      openBuyOrderReservedUsd(wl),
    ]);
    const available = Math.max(0, vault - reserved);
    res.json({
      walletAddress: s.walletAddress,
      onChainVaultUsdc: vault,
      reservedUsdc: reserved,
      pendingSettlementUsdc: pendingSettle,
      openBuyOrdersReservedUsdc: openBuyReserve,
      availableUsdc: available,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.put('/mm-actor', async (req, res) => {
  try {
    const w = normalizeWallet(req.body?.walletAddress);
    if (!w) {
      return res.status(400).json({ message: 'walletAddress is required and must be a valid address' });
    }

    const bot = await ensureBotUserAndLink(w);

    await Settings.findOneAndUpdate(
      { key: 'marketMakerWalletAddress' },
      { key: 'marketMakerWalletAddress', value: w, description: 'Market maker bot wallet address' },
      { upsert: true }
    );

    res.json({
      ok: true,
      walletAddress: w,
      userId: String(bot._id),
      username: bot.username,
    });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ message: e.message });
  }
});

async function controlView(ob) {
  const d = await getOrderbookDefaults();
  const o = ob || {};
  return {
    ...d,
    ...o,
    enabled: o.enabled !== false,
    botEnabled: o.botEnabled !== false,
  };
}

router.get('/matches/:id', async (req, res) => {
  try {
    const m = await Match.findById(req.params.id);
    if (!m) return res.status(404).json({ message: 'Match not found' });
    res.json({ item: m, control: await controlView(m.orderbook) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.put('/matches/:id', async (req, res) => {
  try {
    const m = await Match.findById(req.params.id);
    if (!m) return res.status(404).json({ message: 'Match not found' });
    await applyAdminMarketUpdate(m, 'match', req.body);
    const fresh = await Match.findById(req.params.id);
    res.json({ item: fresh, control: await controlView(fresh.orderbook) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.get('/polls/:id', async (req, res) => {
  try {
    const p = await Poll.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Poll not found' });
    res.json({ item: p, control: await controlView(p.orderbook) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.put('/polls/:id', async (req, res) => {
  try {
    const p = await Poll.findById(req.params.id);
    if (!p) return res.status(404).json({ message: 'Poll not found' });
    await applyAdminMarketUpdate(p, 'poll', req.body);
    const fresh = await Poll.findById(req.params.id);
    res.json({ item: fresh, control: await controlView(fresh.orderbook) });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
});

router.post('/matches/:id/mm-tick', async (req, res) => {
  try {
    const r = await runMatchMmTick(req.params.id);
    if (r.skipped) return res.json(r);
    res.json({ ok: true, ...r });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ message: e.message });
  }
});

router.post('/polls/:id/mm-tick', async (req, res) => {
  try {
    const r = await runPollMmTick(req.params.id);
    if (r.skipped) return res.json(r);
    res.json({ ok: true, ...r });
  } catch (e) {
    const code = e.statusCode || 500;
    res.status(code).json({ message: e.message });
  }
});

const OUTBOX_STATUSES = ['pending', 'processing', 'confirmed', 'dead'];

router.get('/settlement-outbox/jobs', async (req, res) => {
  try {
    const rawStatus = (req.query.status || 'dead').toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const chainMarketId =
      req.query.chainMarketId != null && req.query.chainMarketId !== ''
        ? parseInt(req.query.chainMarketId, 10)
        : null;

    const filter = withOrderbookContract({});
    if (rawStatus !== 'all') {
      if (!OUTBOX_STATUSES.includes(rawStatus)) {
        return res.status(400).json({ message: `status must be one of: all, ${OUTBOX_STATUSES.join(', ')}` });
      }
      filter.status = rawStatus;
    }
    if (Number.isFinite(chainMarketId)) {
      filter.chainMarketId = chainMarketId;
    }

    const jobs = await SettlementOutbox.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select(
        'chainMarketId status attempts lastError txHash orderIds createdAt updatedAt processingStartedAt feeToClaimPool feeToJackpotPool'
      )
      .lean();

    res.json({ jobs, count: jobs.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

router.post('/settlement-outbox/jobs/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid job id' });
    }

    const resetAttempts = req.body?.resetAttempts !== false;

    const job = await SettlementOutbox.findById(id);
    if (!job) {
      return res.status(404).json({ message: 'Job not found' });
    }
    if (job.status !== 'dead') {
      return res.status(400).json({
        message: 'Only dead jobs can be retried this way',
        status: job.status,
      });
    }

    job.status = 'pending';
    job.processingStartedAt = null;
    job.lastError = null;
    if (resetAttempts) {
      job.attempts = 0;
    }
    await job.save();

    res.json({
      ok: true,
      job: {
        _id: job._id,
        chainMarketId: job.chainMarketId,
        status: job.status,
        attempts: job.attempts,
        updatedAt: job.updatedAt,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;
