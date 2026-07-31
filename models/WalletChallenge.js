const mongoose = require('mongoose');

const walletChallengeSchema = new mongoose.Schema({
  address: {
    type: String,
    required: true,
    index: true,
  },
  purpose: {
    type: String,
    enum: ['auth', 'link'],
    required: true,
  },
  nonce: {
    type: String,
    required: true,
    unique: true,
  },
  message: {
    type: String,
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  used: {
    type: Boolean,
    default: false,
    index: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

walletChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
walletChallengeSchema.index({ address: 1, purpose: 1, used: 1 });

module.exports = mongoose.model('WalletChallenge', walletChallengeSchema);
