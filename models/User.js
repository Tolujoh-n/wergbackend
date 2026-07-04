const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
  },
  email: {
    type: String,
    unique: true,
    sparse: true,
  },
  /** Verified for free predictions (email OTP). */
  emailVerified: {
    type: Boolean,
    default: false,
  },
  /** Last successful free-play email OTP verification (re-verify every 30 days). */
  emailVerifiedAt: {
    type: Date,
  },
  freePlayEmailVerification: {
    codeHash: { type: String },
    expiresAt: { type: Date },
    sentAt: { type: Date },
    attempts: { type: Number, default: 0 },
    pendingEmail: { type: String },
  },
  password: {
    type: String,
  },
  walletAddress: {
    type: String,
    unique: true,
    sparse: true,
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'superAdmin'],
    default: 'user',
  },
  points: {
    type: Number,
    default: 0,
  },
  /** Legacy daily remaining (kept in sync for display; source of truth is freeTicketsUsedToday). */
  tickets: {
    type: Number,
    default: 1,
  },
  /** Free tickets (daily limit + NFT bonus) consumed during the current UTC day. Resets daily. */
  freeTicketsUsedToday: {
    type: Number,
    default: 0,
  },
  /** Accumulating spendable tickets (boost rewards, admin gifts). */
  goldenTickets: {
    type: Number,
    default: 0,
  },
  lastTicketDate: {
    type: Date,
  },
  streak: {
    type: Number,
    default: 0,
  },
  /** Login / free / boost engagement streaks (current + best per type). */
  engagementStreaks: {
    login: {
      current: { type: Number, default: 0 },
      best: { type: Number, default: 0 },
      lastDay: { type: String, default: null },
    },
    free: {
      current: { type: Number, default: 0 },
      best: { type: Number, default: 0 },
      lastDay: { type: String, default: null },
    },
    boost: {
      current: { type: Number, default: 0 },
      best: { type: Number, default: 0 },
      lastDay: { type: String, default: null },
    },
  },
  totalPredictions: {
    type: Number,
    default: 0,
  },
  correctPredictions: {
    type: Number,
    default: 0,
  },
  // Jackpot balance
  jackpotBalance: {
    type: Number,
    default: 0,
  },
  /** USDC reserved for an in-flight jackpot claim (debited from jackpotBalance at authorization). */
  jackpotBalancePending: {
    type: Number,
    default: 0,
  },
  jackpotWithdrawn: {
    type: Number,
    default: 0,
  },
  jackpotWins: {
    type: Number,
    default: 0,
  },
  // Atomic guard against issuing two jackpot-withdraw signatures concurrently.
  jackpotWithdrawInProgress: {
    type: Boolean,
    default: false,
  },
  jackpotWithdrawLockedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },

  passwordReset: {
    provider: { type: String },
    codeHash: { type: String },
    verifiedAt: { type: Date },
    expiresAt: { type: Date },
    sentAt: { type: Date },
    attempts: { type: Number, default: 0 },
  },
  /** @deprecated SMS verification — legacy field kept for existing users. */
  phone: {
    type: String,
    trim: true,
  },
  phoneVerified: {
    type: Boolean,
    default: false,
  },
  phoneVerification: {
    codeHash: { type: String },
    expiresAt: { type: Date },
    sentAt: { type: Date },
    attempts: { type: Number, default: 0 },
  },
  /** Unique share code for referral links (generated on first visit to referral page). */
  referralCode: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true,
  },
  /** User who referred this account (set once at signup). */
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  /** Platform ban — blocked from login and authenticated API access. */
  banned: {
    type: Boolean,
    default: false,
    index: true,
  },
  bannedAt: {
    type: Date,
  },
  bannedReason: {
    type: String,
    default: '',
  },
  bannedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  /** Cached on-chain NFT/FT bonus verification (fast free-page loads). */
  nftHoldingsCache: {
    rows: { type: mongoose.Schema.Types.Mixed, default: null },
    walletScope: { type: String, default: '' },
    additionalWallet: { type: String, default: '' },
    configFingerprint: { type: String, default: '' },
    verifiedAt: { type: Date },
  },
});

userSchema.index({ phone: 1 }, { unique: true, sparse: true, partialFilterExpression: { phoneVerified: true } });

userSchema.pre('save', async function () {
  if (!this.isModified('password') || !this.password) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);
