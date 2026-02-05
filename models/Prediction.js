const mongoose = require('mongoose');

const predictionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  match: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Match',
  },
  poll: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Poll',
  },
  type: {
    type: String,
    enum: ['free', 'boost', 'market'],
    required: true,
  },
  outcome: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    default: 0,
  },
  // For boost: track total stake (can be increased/decreased)
  totalStake: {
    type: Number,
    default: 0,
  },
  // For market: track shares owned
  shares: {
    type: Number,
    default: 0,
  },
  // For market: track total invested
  totalInvested: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'won', 'lost', 'settled'],
    default: 'pending',
  },
  payout: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Prediction', predictionSchema);
