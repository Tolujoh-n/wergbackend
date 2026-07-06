const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Referral = require('../models/Referral');
const { resolveUserByIdentifier } = require('../utils/resolveUserByIdentifier');
const {
  isFreePlayEmailValid,
  needsEmailReverification,
} = require('../services/emailVerificationService');

const BAN_MESSAGE = 'Your account is banned for unusual activities.';

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isBanned(user) {
  return Boolean(user?.banned);
}

function assertUserNotBanned(user) {
  if (isBanned(user)) {
    const err = new Error(BAN_MESSAGE);
    err.statusCode = 403;
    err.code = 'ACCOUNT_BANNED';
    throw err;
  }
}

async function resolveUserForBan({ userId, username, email, walletAddress, identifier }) {
  if (userId) {
    return User.findById(userId);
  }
  const raw = String(identifier || username || email || walletAddress || '').trim();
  if (!raw) return null;

  if (username && !String(username).includes('@') && !/^0x[a-f0-9]{40}$/i.test(String(username))) {
    const byUsername = await User.findOne({ username: String(username).trim() });
    if (byUsername) return byUsername;
  }

  return resolveUserByIdentifier({ email, walletAddress, identifier: raw });
}

async function banUserById(userId, { reason, bannedBy } = {}) {
  const user = await User.findById(userId).select('role username banned');
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  if (user.role === 'admin' || user.role === 'superAdmin') {
    const err = new Error('Cannot ban admin accounts');
    err.statusCode = 403;
    throw err;
  }
  if (user.banned) {
    return { user, alreadyBanned: true };
  }
  user.banned = true;
  user.bannedAt = new Date();
  user.bannedReason = reason || BAN_MESSAGE;
  if (bannedBy) user.bannedBy = bannedBy;
  await user.save();
  return { user, alreadyBanned: false };
}

async function unbanUserById(userId) {
  const user = await User.findById(userId).select('username banned');
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  user.banned = false;
  user.bannedAt = null;
  user.bannedReason = '';
  user.bannedBy = null;
  await user.save();
  return user;
}

async function buildUserSearchQuery(searchRaw) {
  const search = String(searchRaw || '').trim();
  if (!search) return {};

  if (/^0x[a-f0-9]{40}$/i.test(search)) {
    const wallet = search.toLowerCase();
    const link = await WalletLink.findOne({ walletAddress: wallet }).select('user').lean();
    if (link?.user) {
      return { _id: link.user };
    }
    return { $or: [{ walletAddress: wallet }] };
  }

  if (search.includes('@')) {
    const safe = escapeRegExp(search);
    return { email: new RegExp(safe, 'i') };
  }

  const safe = escapeRegExp(search);
  const regex = new RegExp(safe, 'i');
  return { $or: [{ username: regex }, { email: regex }] };
}

function emailVerificationCutoff() {
  const days = Math.max(1, parseInt(process.env.EMAIL_VERIFY_VALID_DAYS || '30', 10));
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function buildVerifiedFilterQuery(verifiedFilter) {
  const filter = String(verifiedFilter || 'all').toLowerCase();
  if (filter === 'all') return {};

  const cutoff = emailVerificationCutoff();
  if (filter === 'verified') {
    return {
      emailVerified: true,
      emailVerifiedAt: { $gte: cutoff },
    };
  }
  if (filter === 'expired') {
    return {
      emailVerified: true,
      emailVerifiedAt: { $exists: true, $ne: null, $lt: cutoff },
    };
  }
  if (filter === 'unverified') {
    return {
      $or: [
        { emailVerified: { $ne: true } },
        { emailVerifiedAt: { $exists: false } },
        { emailVerifiedAt: null },
      ],
    };
  }
  return {};
}

async function getEmailVerificationStats(baseQuery = {}) {
  const cutoff = emailVerificationCutoff();
  const [verified, expired, unverified] = await Promise.all([
    User.countDocuments({
      ...baseQuery,
      emailVerified: true,
      emailVerifiedAt: { $gte: cutoff },
    }),
    User.countDocuments({
      ...baseQuery,
      emailVerified: true,
      emailVerifiedAt: { $exists: true, $ne: null, $lt: cutoff },
    }),
    User.countDocuments({
      ...baseQuery,
      $or: [
        { emailVerified: { $ne: true } },
        { emailVerifiedAt: { $exists: false } },
        { emailVerifiedAt: null },
      ],
    }),
  ]);
  return { verified, expired, unverified, total: verified + expired + unverified };
}

function emailVerificationLabel(user) {
  if (isFreePlayEmailValid(user)) return 'verified';
  if (needsEmailReverification(user)) return 'expired';
  return 'unverified';
}

async function listUsersForAdmin({ page = 1, limit = 20, search = '', verifiedFilter = 'all' }) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const skip = (safePage - 1) * safeLimit;
  const searchQuery = await buildUserSearchQuery(search);
  const verifiedQuery = buildVerifiedFilterQuery(verifiedFilter);
  const query =
    Object.keys(searchQuery).length && Object.keys(verifiedQuery).length
      ? { $and: [searchQuery, verifiedQuery] }
      : { ...searchQuery, ...verifiedQuery };

  const [users, total, emailStats] = await Promise.all([
    User.find(query)
      .select('username email walletAddress banned bannedAt createdAt role goldenTickets emailVerified emailVerifiedAt phoneVerified')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    User.countDocuments(query),
    getEmailVerificationStats(),
  ]);

  const ids = users.map((u) => u._id);
  const [referralCounts, walletLinks] = await Promise.all([
    Referral.aggregate([
      { $match: { referrer: { $in: ids } } },
      { $group: { _id: '$referrer', count: { $sum: 1 } } },
    ]),
    WalletLink.find({ user: { $in: ids } })
      .select('user walletAddress')
      .lean(),
  ]);

  const referralMap = new Map(referralCounts.map((r) => [String(r._id), r.count]));
  const walletsByUser = new Map();
  for (const link of walletLinks) {
    const key = String(link.user);
    if (!walletsByUser.has(key)) walletsByUser.set(key, []);
    walletsByUser.get(key).push(link.walletAddress);
  }

  const items = users.map((u) => {
    const linked = walletsByUser.get(String(u._id)) || [];
    return {
      id: u._id,
      username: u.username,
      email: u.email || null,
      walletAddress: u.walletAddress || linked[0] || null,
      linkedWallets: linked,
      banned: Boolean(u.banned),
      bannedAt: u.bannedAt || null,
      role: u.role,
      goldenTickets: u.goldenTickets ?? 0,
      referralCount: referralMap.get(String(u._id)) || 0,
      createdAt: u.createdAt,
      emailVerified: Boolean(u.emailVerified),
      emailVerifiedAt: u.emailVerifiedAt || null,
      emailVerificationStatus: emailVerificationLabel(u),
    };
  });

  return {
    items,
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.max(1, Math.ceil(total / safeLimit)),
    emailStats,
  };
}

module.exports = {
  BAN_MESSAGE,
  isBanned,
  assertUserNotBanned,
  resolveUserForBan,
  banUserById,
  unbanUserById,
  listUsersForAdmin,
};
