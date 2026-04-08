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
    codeHash: { type: String },
    expiresAt: { type: Date },
    sentAt: { type: Date },
    attempts: { type: Number, default: 0 },
  },
});

userSchema.pre('save', async function () {
  if (!this.isModified('password') || !this.password) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = async function (password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);
