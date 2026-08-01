const Settings = require('../models/Settings');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const { setJackpotBalanceOnChain } = require('../utils/jackpotOnChainSync');

const SETTINGS_KEY = 'jackpotClaimEligibleFrom';

async function getJackpotClaimEligibleFrom() {
  const s = await Settings.findOne({ key: SETTINGS_KEY }).lean();
  const raw = s?.value;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(typeof raw === 'object' ? raw.date || raw : raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

async function setJackpotClaimEligibleFrom(dateInput) {
  if (dateInput === null || dateInput === '' || dateInput === undefined) {
    await Settings.findOneAndUpdate(
      { key: SETTINGS_KEY },
      {
        $set: {
          value: null,
          description: 'Only Free jackpot wins from events on/after this date are claimable',
          updatedAt: new Date(),
        },
        $setOnInsert: { key: SETTINGS_KEY },
      },
      { upsert: true, new: true }
    );
    return null;
  }
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) {
    const err = new Error('Invalid jackpot eligibility date');
    err.statusCode = 400;
    throw err;
  }
  d.setUTCHours(0, 0, 0, 0);
  await Settings.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $set: {
        value: d.toISOString(),
        description: 'Only Free jackpot wins from events on/after this date are claimable',
        updatedAt: new Date(),
      },
      $setOnInsert: { key: SETTINGS_KEY },
    },
    { upsert: true, new: true }
  );
  return d;
}

function eventDateForEligibility(event) {
  if (!event) return null;
  if (event.date) return new Date(event.date);
  if (event.resolvedAt) return new Date(event.resolvedAt);
  return null;
}

/**
 * Returns true if the free win's match/poll is on/after the eligibility cutoff (or no cutoff).
 */
async function isFreeWinEligible(prediction, cutoff) {
  if (!cutoff) return true;
  let event = null;
  if (prediction.match) {
    event = await Match.findById(prediction.match).select('date resolvedAt').lean();
  } else if (prediction.poll) {
    event = await Poll.findById(prediction.poll).select('date resolvedAt').lean();
  }
  const ed = eventDateForEligibility(event);
  if (!ed || Number.isNaN(ed.getTime())) return false;
  return ed.getTime() >= cutoff.getTime();
}

/**
 * Sum of unclaimed eligible free jackpot payouts for a user (claimable amount basis).
 */
async function sumEligibleUnclaimedJackpot(userId, { cutoff } = {}) {
  const cut = cutoff === undefined ? await getJackpotClaimEligibleFrom() : cutoff;
  const preds = await Prediction.find({
    user: userId,
    type: 'free',
    status: 'won',
    jackpotClaimed: { $ne: true },
    jackpotPayout: { $gt: 0 },
  })
    .select('jackpotPayout match poll')
    .lean();

  if (!preds.length) return { total: 0, predictions: [] };

  const matchIds = [...new Set(preds.filter((p) => p.match).map((p) => String(p.match)))];
  const pollIds = [...new Set(preds.filter((p) => p.poll).map((p) => String(p.poll)))];
  const [matches, polls] = await Promise.all([
    matchIds.length
      ? Match.find({ _id: { $in: matchIds } }).select('date resolvedAt').lean()
      : [],
    pollIds.length ? Poll.find({ _id: { $in: pollIds } }).select('date resolvedAt').lean() : [],
  ]);
  const matchMap = Object.fromEntries(matches.map((m) => [String(m._id), m]));
  const pollMap = Object.fromEntries(polls.map((p) => [String(p._id), p]));

  const eligible = [];
  let total = 0;
  for (const p of preds) {
    if (!cut) {
      eligible.push(p);
      total += Number(p.jackpotPayout) || 0;
      continue;
    }
    const event = p.match ? matchMap[String(p.match)] : pollMap[String(p.poll)];
    const ed = eventDateForEligibility(event);
    if (ed && ed.getTime() >= cut.getTime()) {
      eligible.push(p);
      total += Number(p.jackpotPayout) || 0;
    }
  }
  return { total: Math.round(total * 1e6) / 1e6, predictions: eligible };
}

/**
 * Recalculate every user's jackpotBalance from eligible unclaimed wins (minus pending).
 * Optionally sync on-chain balances for linked wallets.
 */
async function recalculateAllJackpotBalances({ syncOnChain = false } = {}) {
  const cutoff = await getJackpotClaimEligibleFrom();
  const users = await User.find({
    $or: [
      { jackpotBalance: { $gt: 0 } },
      { jackpotBalancePending: { $gt: 0 } },
      { jackpotWins: { $gt: 0 } },
    ],
  })
    .select('_id jackpotBalancePending walletAddress')
    .lean();

  let updated = 0;
  const syncJobs = [];

  for (const u of users) {
    const { total } = await sumEligibleUnclaimedJackpot(u._id, { cutoff });
    const pending = Math.max(0, Number(u.jackpotBalancePending) || 0);
    const nextBalance = Math.max(0, Math.round((total - pending) * 1e6) / 1e6);
    await User.updateOne({ _id: u._id }, { $set: { jackpotBalance: nextBalance } });
    updated += 1;

    if (syncOnChain) {
      const link =
        (await WalletLink.findOne({ user: u._id, isPrimary: true }).lean()) ||
        (await WalletLink.findOne({ user: u._id }).lean());
      const wallet = link?.walletAddress || u.walletAddress;
      if (wallet) {
        const onChainTarget = Math.round((nextBalance + pending) * 1e6) / 1e6;
        syncJobs.push({ walletAddress: wallet, balanceUsdc: onChainTarget });
      }
    }
  }

  let synced = 0;
  if (syncOnChain && syncJobs.length) {
    for (const job of syncJobs) {
      try {
        await setJackpotBalanceOnChain(job.walletAddress, job.balanceUsdc);
        synced += 1;
      } catch (e) {
        console.warn('[jackpotEligibility] sync failed', job.walletAddress, e.message);
      }
    }
  }

  return {
    cutoff: cutoff ? cutoff.toISOString() : null,
    usersUpdated: updated,
    onChainSynced: synced,
  };
}

module.exports = {
  SETTINGS_KEY,
  getJackpotClaimEligibleFrom,
  setJackpotClaimEligibleFrom,
  isFreeWinEligible,
  sumEligibleUnclaimedJackpot,
  recalculateAllJackpotBalances,
  eventDateForEligibility,
};
