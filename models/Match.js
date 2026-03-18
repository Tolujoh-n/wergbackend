const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  teamA: {
    type: String,
    required: true,
  },
  teamB: {
    type: String,
    required: true,
  },
  teamAImage: {
    type: String,
  },
  teamBImage: {
    type: String,
  },
  date: {
    type: Date,
    required: true,
  },
  cup: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cup',
    required: true,
  },
  stage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Stage',
  },
  stageName: {
    type: String,
  },
  status: {
    type: String,
    enum: ['upcoming', 'live', 'completed', 'locked'],
    default: 'upcoming',
  },
  result: {
    type: String,
  },
  freePredictions: {
    type: Number,
    default: 0,
  },
  boostPool: {
    type: Number,
    default: 0,
  },
  marketId: {
    type: Number,
  },
  marketInitialized: {
    type: Boolean,
    default: false,
  },
  // Market shares for 3 outcomes (TeamA, TeamB, Draw)
  marketTeamAShares: {
    type: Number,
    default: 0,
  },
  marketTeamBShares: {
    type: Number,
    default: 0,
  },
  marketDrawShares: {
    type: Number,
    default: 0,
  },
  // Market liquidity for 3 outcomes
  marketTeamALiquidity: {
    type: Number,
    default: 0,
  },
  marketTeamBLiquidity: {
    type: Number,
    default: 0,
  },
  marketDrawLiquidity: {
    type: Number,
    default: 0,
  },
  isFeatured: {
    type: Boolean,
    default: false,
  },
  isSponsored: {
    type: Boolean,
    default: false,
  },
  sponsoredImages: [{
    type: String,
  }],
  lockedTime: {
    type: Date,
  },
  isResolved: {
    type: Boolean,
    default: false,
  },
  // Jackpot pools
  freeJackpotPool: {
    type: Number,
    default: 0,
  },
  boostJackpotPool: {
    type: Number,
    default: 0,
  },
  // Store original jackpot amounts before distribution (for display after resolution)
  originalFreeJackpotPool: {
    type: Number,
    default: 0,
  },
  originalBoostJackpotPool: {
    type: Number,
    default: 0,
  },
  // Platform fees collected
  platformFees: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Match', matchSchema);
