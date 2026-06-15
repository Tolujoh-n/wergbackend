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
  tickets: {
    type: Number,
    default: 1,
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
  jackpotWithdrawn: {
    type: Number,
    default: 0,
  },
  jackpotWins: {
    type: Number,
    default: 0,
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
  /** E.164 format, e.g. +14155552671 */
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
