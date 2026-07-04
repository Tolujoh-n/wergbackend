const crypto = require('crypto');
const User = require('../models/User');
const Referral = require('../models/Referral');
const Settings = require('../models/Settings');
const { awardGoldenTickets } = require('./ticketService');

const REFERRAL_SETTINGS_KEY = 'referralRewards';
const DEFAULT_REWARDS = { enabled: true, goldenTicketsPerReferral: 1 };

function normalizeReferralCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function getReferralRewardSettings() {
  const doc = await Settings.findOne({ key: REFERRAL_SETTINGS_KEY }).lean();
  const v = doc?.value && typeof doc.value === 'object' ? doc.value : {};
  return {
    enabled: v.enabled !== false,
    goldenTicketsPerReferral: Math.max(
      0,
      parseInt(v.goldenTicketsPerReferral, 10) || DEFAULT_REWARDS.goldenTicketsPerReferral
    ),
  };
}

async function setReferralRewardSettings({ enabled, goldenTicketsPerReferral }) {
  const value = {
    enabled: enabled !== false,
    goldenTicketsPerReferral: Math.max(0, parseInt(goldenTicketsPerReferral, 10) || 0),
  };
  await Settings.findOneAndUpdate(
    { key: REFERRAL_SETTINGS_KEY },
    { key: REFERRAL_SETTINGS_KEY, value },
    { upsert: true, new: true }
  );
  return value;
}

async function generateUniqueReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i += 1) {
      code += alphabet[bytes[i] % alphabet.length];
    }
    const exists = await User.findOne({ referralCode: code }).select('_id').lean();
    if (!exists) return code;
  }
  throw new Error('Could not generate referral code');
}

async function ensureUserReferralCode(userId) {
  const user = await User.findById(userId).select('referralCode username');
  if (!user) return null;
  if (user.referralCode) return user.referralCode;
  const code = await generateUniqueReferralCode();
  await User.updateOne({ _id: userId }, { $set: { referralCode: code } });
  return code;
}

/**
 * Attach a new user to a referrer (pending until first free prediction).
 */
async function processReferralSignup({ referralCodeRaw, newUserId }) {
  const code = normalizeReferralCode(referralCodeRaw);
  if (!code || !newUserId) return { applied: false };

  const settings = await getReferralRewardSettings();
  if (!settings.enabled) {
    return { applied: false, reason: 'referrals_disabled' };
  }

  const newUser = await User.findById(newUserId).select('referredBy username');
  if (!newUser || newUser.referredBy) {
    return { applied: false, reason: 'already_referred' };
  }

  const referrer = await User.findOne({ referralCode: code }).select('_id referralCode username');
  if (!referrer) {
    return { applied: false, reason: 'invalid_code' };
  }
  if (String(referrer._id) === String(newUserId)) {
    return { applied: false, reason: 'self_referral' };
  }

  try {
    await Referral.create({
      referrer: referrer._id,
      referredUser: newUserId,
      referralCode: code,
      status: 'pending',
      goldenTicketsAwarded: 0,
    });
  } catch (e) {
    if (e?.code === 11000) {
      return { applied: false, reason: 'duplicate' };
    }
    throw e;
  }

  await User.updateOne({ _id: newUserId }, { $set: { referredBy: referrer._id } });

  return {
    applied: true,
    referrerId: referrer._id,
    status: 'pending',
    goldenTicketsAwarded: 0,
  };
}

/**
 * Award golden tickets when referred user makes their first free prediction.
 */
async function verifyReferralOnFirstFreePrediction(referredUserId) {
  const settings = await getReferralRewardSettings();
  if (!settings.enabled || settings.goldenTicketsPerReferral <= 0) {
    return { verified: false, reason: 'disabled' };
  }

  const tickets = settings.goldenTicketsPerReferral;
  const referral = await Referral.findOneAndUpdate(
    { referredUser: referredUserId, status: 'pending' },
    {
      $set: {
        status: 'verified',
        verifiedAt: new Date(),
        goldenTicketsAwarded: tickets,
      },
    },
    { new: true }
  );

  if (!referral) {
    return { verified: false, reason: 'not_pending' };
  }

  await awardGoldenTickets(referral.referrer, tickets);

  return {
    verified: true,
    referrerId: referral.referrer,
    goldenTicketsAwarded: tickets,
  };
}

async function getReferralDashboard(userId) {
  const [code, settings, referrals, user] = await Promise.all([
    ensureUserReferralCode(userId),
    getReferralRewardSettings(),
    Referral.find({ referrer: userId })
      .populate('referredUser', 'username email createdAt')
      .sort({ createdAt: -1 })
      .lean(),
    User.findById(userId).select('goldenTickets referredBy').lean(),
  ]);

  const totalReferred = referrals.length;
  const pendingReferrals = referrals.filter((r) => (r.status || 'verified') === 'pending').length;
  const verifiedReferrals = referrals.filter((r) => (r.status || 'verified') === 'verified').length;
  const goldenTicketsFromReferrals = referrals.reduce(
    (sum, r) => sum + ((r.status === 'verified' || !r.status) ? (r.goldenTicketsAwarded || 0) : 0),
    0
  );

  return {
    referralCode: code,
    rewardSettings: settings,
    stats: {
      totalReferred,
      pendingReferrals,
      verifiedReferrals,
      goldenTicketsFromReferrals,
      goldenTicketsPerReferral: settings.goldenTicketsPerReferral,
      currentGoldenTicketBalance: user?.goldenTickets ?? 0,
    },
    referrals: referrals.map((r) => {
      const status = r.status || (r.goldenTicketsAwarded > 0 ? 'verified' : 'pending');
      return {
        id: r._id,
        username: r.referredUser?.username || 'User',
        email: r.referredUser?.email || null,
        joinedAt: r.referredUser?.createdAt || r.createdAt,
        status,
        verifiedAt: r.verifiedAt || null,
        goldenTicketsAwarded: status === 'verified' ? (r.goldenTicketsAwarded || 0) : 0,
      };
    }),
  };
}

async function validateReferralCodePublic(codeRaw) {
  const code = normalizeReferralCode(codeRaw);
  if (!code) return { valid: false };
  const user = await User.findOne({ referralCode: code }).select('username').lean();
  if (!user) return { valid: false };
  const settings = await getReferralRewardSettings();
  return {
    valid: true,
    referrerUsername: user.username,
    goldenTicketsPerReferral: settings.goldenTicketsPerReferral,
    requiresFreePrediction: true,
  };
}

module.exports = {
  normalizeReferralCode,
  getReferralRewardSettings,
  setReferralRewardSettings,
  ensureUserReferralCode,
  processReferralSignup,
  verifyReferralOnFirstFreePrediction,
  getReferralDashboard,
  validateReferralCodePublic,
  REFERRAL_SETTINGS_KEY,
};
