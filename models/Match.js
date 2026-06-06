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
  /** Minimum tickets required to enter free prediction (per pick). */
  minFreeTickets: {
    type: Number,
    default: 1,
    min: 1,
  },
  /** When false, free prediction UI is hidden for this match. */
  freePredictionEnabled: {
    type: Boolean,
    default: true,
  },
  /** When false, Draw outcome is omitted (contract + UI). */
  drawEnabled: {
    type: Boolean,
    default: true,
  },
  /** Per-outcome YES/NO mid prices for MM (each pair should sum to 1). */
  startingPrices: [
    {
      optionKey: { type: String },
      yesPrice: { type: Number, default: 0.5 },
      noPrice: { type: Number, default: 0.5 },
    },
  ],
  boostPool: {
    type: Number,
    default: 0,
  },
  /** Boost pool size at resolution (for display after prizes are paid). */
  originalBoostPool: {
    type: Number,
    default: 0,
  },
  marketId: {
    type: Number,
  },
  /** WeRgame deployment for this on-chain market (scopes orderbook DB when market IDs reset on redeploy). */
  contractAddress: {
    type: String,
    lowercase: true,
    trim: true,
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
  /** Orderbook + market-maker controls (off-chain book; on-chain settlement) */
  orderbook: {
    enabled: { type: Boolean, default: true },
    botEnabled: { type: Boolean, default: true },
    marketPaused: { type: Boolean, default: false },
    pauseSideYes: { type: Boolean, default: false },
    pauseSideNo: { type: Boolean, default: false },
    /** Per-outcome YES/NO pause (stacks with global pauseSide*). */
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
    /** When MM YES exposure (USDC) reaches this, quotes use a wider spread (see market maker worker). */
    widenSpreadYesCapUsdc: { type: Number, default: 0 },
    widenSpreadNoCapUsdc: { type: Number, default: 0 },
    /** Bot-applied pauses from risk caps (additive to admin marketPaused / pauseSide*). */
    riskPausedMarket: { type: Boolean, default: false },
    riskPausedYes: { type: Boolean, default: false },
    riskPausedNo: { type: Boolean, default: false },
    /** Last widen mode for MM quote reset when exposure crosses thresholds. */
    mmWidenActiveYes: { type: Boolean, default: false },
    mmWidenActiveNo: { type: Boolean, default: false },
    botLastTickAt: { type: Date },
    /** Per-outcome YES/NO seed liquidity (USDC) used at create / add liquidity UI */
    liquidityYesNo: [
      {
        optionKey: { type: String },
        yes: { type: Number, default: 0 },
        no: { type: Number, default: 0 },
      },
    ],
  },
});

matchSchema.index({ contractAddress: 1, marketId: 1 }, { sparse: true });

module.exports = mongoose.model('Match', matchSchema);
