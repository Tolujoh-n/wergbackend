const mongoose = require('mongoose');

const pollSchema = new mongoose.Schema({
  question: {
    type: String,
    required: true,
  },
  thumbnailImage: {
    type: String,
  },
  description: {
    type: String,
  },
  type: {
    type: String,
    enum: ['match', 'team', 'stage', 'award'],
    required: true,
  },
  optionType: {
    type: String,
    enum: ['normal', 'options'],
    default: 'options',
  },
  options: [{
    text: {
      type: String,
      required: true,
    },
    image: {
      type: String,
    },
    liquidity: {
      type: Number,
      default: 0,
    },
    shares: {
      type: Number,
      default: 0,
    },
  }],
  cup: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cup',
    required: true,
  },
  stage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Stage',
  },
  status: {
    type: String,
    enum: ['upcoming', 'active', 'settled', 'locked'],
    default: 'active',
  },
  result: {
    type: String,
  },
  minFreeTickets: {
    type: Number,
    default: 1,
    min: 1,
  },
  freePredictionEnabled: {
    type: Boolean,
    default: true,
  },
  /** When false, market/orderbook entry is hidden on list cards. */
  marketEnabled: {
    type: Boolean,
    default: true,
  },
  startingPrices: [
    {
      optionKey: { type: String },
      yesPrice: { type: Number, default: 0.5 },
      noPrice: { type: Number, default: 0.5 },
      quoteVolumeUsdc: { type: Number, default: 200 },
      yesQuoteVolumeUsdc: { type: Number },
      noQuoteVolumeUsdc: { type: Number },
    },
  ],
  marketId: {
    type: Number,
  },
  contractAddress: {
    type: String,
    lowercase: true,
    trim: true,
  },
  marketInitialized: {
    type: Boolean,
    default: false,
  },
  marketYesShares: {
    type: Number,
    default: 0,
  },
  marketNoShares: {
    type: Number,
    default: 0,
  },
  marketYesLiquidity: {
    type: Number,
    default: 0,
  },
  marketNoLiquidity: {
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
  boostPool: {
    type: Number,
    default: 0,
  },
  originalBoostPool: {
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
  orderbook: {
    enabled: { type: Boolean, default: true },
    botEnabled: { type: Boolean, default: true },
    marketPaused: { type: Boolean, default: false },
    pauseSideYes: { type: Boolean, default: false },
    pauseSideNo: { type: Boolean, default: false },
    pauseByOption: [
      {
        optionKey: { type: String },
        pauseYes: { type: Boolean, default: false },
        pauseNo: { type: Boolean, default: false },
      },
    ],
    spreadBps: { type: Number, default: 80 },
    minSpreadFloorBps: { type: Number, default: 20 },
    quoteSizeUsdc: { type: Number, default: 50 },
    maxSlippageBps: { type: Number, default: 300 },
    maxTreasuryLossUsdc: { type: Number, default: 100000 },
    maxTreasuryLossYesUsdc: { type: Number, default: 50000 },
    maxTreasuryLossNoUsdc: { type: Number, default: 50000 },
    maxMarketAllocationUsdc: { type: Number, default: 250000 },
    widenSpreadYesCapUsdc: { type: Number, default: 0 },
    widenSpreadNoCapUsdc: { type: Number, default: 0 },
    riskPausedMarket: { type: Boolean, default: false },
    riskPausedYes: { type: Boolean, default: false },
    riskPausedNo: { type: Boolean, default: false },
    mmWidenActiveYes: { type: Boolean, default: false },
    mmWidenActiveNo: { type: Boolean, default: false },
    botLastTickAt: { type: Date },
    liquidityYesNo: [
      {
        optionKey: { type: String },
        yes: { type: Number, default: 0 },
        no: { type: Number, default: 0 },
      },
    ],
  },
});

pollSchema.index({ contractAddress: 1, marketId: 1 }, { sparse: true });

module.exports = mongoose.model('Poll', pollSchema);
