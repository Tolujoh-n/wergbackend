/**
 * Compare MongoDB jackpot liabilities vs on-chain withdrawals.
 * Usage: node scripts/jackpotDbReconcile.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Prediction = require('../models/Prediction');

const ON_CHAIN_WITHDRAWN_USDC = 1576.988162;
const ON_CHAIN_JACKPOT_POOL_USDC = 0.196838;

const TOP_WALLETS = [
  '0x60C911A84c68E304545c97743312400e116F5Fb0',
  '0x5ff2A7cd9F5e25f6451cB9De4B0225E0E70cbd6d',
  '0x49c33F0C9408736A751680F1c5756A4d1f07F582',
  '0x7Daf1105b42A73179538A9AC4B280F2da4e433e0',
  '0x9299187C57c8Fc24967448F9370D8856e064a4C6',
  '0x548244d51Ac9f5e714238e4a45d4dee1A68D0Ade',
  '0x02871d31f0895E38fdEDbF053c63e2259706120F',
  '0x4F1a3a6F52416ACD421ea4ef0DDc96bF465E2e34',
  '0xe78AF8150292EAc52a5111691e60cF477B445f0D',
  '0x9E07c87064d0b1189fD886F446CeC078A90Dd71b',
  '0xA60AEB71a444E5B4C569658160aeC462445fD02D',
  '0x7986c73B145E82BCA6f0183d361538Cd76F72eDe',
  '0xd2B797a0cC87e991bfC2357B4a490eF7d014D5D4',
  '0xbFd49C3D8f2Fe1Aa2e5a5774e7625D1A6A949916',
  '0x35274921208c05312971F86c72Cf41af62d2c657',
];

function norm(addr) {
  return String(addr || '').trim().toLowerCase();
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');
  await mongoose.connect(uri);

  const [totals] = await User.aggregate([
    {
      $group: {
        _id: null,
        users: { $sum: 1 },
        totalJackpotBalance: { $sum: { $ifNull: ['$jackpotBalance', 0] } },
        totalJackpotWithdrawn: { $sum: { $ifNull: ['$jackpotWithdrawn', 0] } },
        totalJackpotWins: { $sum: { $ifNull: ['$jackpotWins', 0] } },
        usersWithBalance: {
          $sum: { $cond: [{ $gt: [{ $ifNull: ['$jackpotBalance', 0] }, 0] }, 1, 0] },
        },
        usersWithWithdrawn: {
          $sum: { $cond: [{ $gt: [{ $ifNull: ['$jackpotWithdrawn', 0] }, 0] }, 1, 0] },
        },
      },
    },
  ]);

  const freeJackpotEarned = await Prediction.aggregate([
    { $match: { type: 'free', jackpotPayout: { $gt: 0 } } },
    {
      $group: {
        _id: null,
        totalJackpotPayout: { $sum: '$jackpotPayout' },
        predictionCount: { $sum: 1 },
        uniqueUsers: { $addToSet: '$user' },
      },
    },
  ]);

  const ledgerPath = path.join(__dirname, '..', 'jackpot-ledger-report.json');
  let onChainFromLedger = ON_CHAIN_WITHDRAWN_USDC;
  if (fs.existsSync(ledgerPath)) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    onChainFromLedger = parseFloat(ledger.summary?.totalOutLoggedUsdc || ON_CHAIN_WITHDRAWN_USDC);
  }

  const walletChecks = [];
  for (const wallet of TOP_WALLETS) {
    const w = norm(wallet);
    const link = await WalletLink.findOne({ walletAddress: w }).lean();
    let user = null;
    if (link?.user) {
      user = await User.findById(link.user)
        .select('username email jackpotBalance jackpotWithdrawn jackpotWins walletAddress')
        .lean();
    }
    if (!user) {
      user = await User.findOne({ walletAddress: new RegExp(`^${w}$`, 'i') })
        .select('username email jackpotBalance jackpotWithdrawn jackpotWins walletAddress')
        .lean();
    }

    const freeWins = user
      ? await Prediction.find({
          user: user._id,
          type: 'free',
          jackpotPayout: { $gt: 0 },
        })
          .select('jackpotPayout match poll outcome status createdAt')
          .lean()
      : [];

    const earnedFromPredictions = freeWins.reduce((s, p) => s + (p.jackpotPayout || 0), 0);

    walletChecks.push({
      wallet,
      inDb: !!user,
      username: user?.username || null,
      userId: user?._id?.toString() || null,
      dbJackpotBalance: user?.jackpotBalance ?? null,
      dbJackpotWithdrawn: user?.jackpotWithdrawn ?? null,
      dbJackpotWins: user?.jackpotWins ?? null,
      freeJackpotWinRows: freeWins.length,
      freeJackpotEarnedSum: Math.round(earnedFromPredictions * 1e6) / 1e6,
      walletLinked: !!link,
    });
  }

  const unclaimedUsers = await User.find({ jackpotBalance: { $gt: 0 } })
    .select('username jackpotBalance jackpotWithdrawn jackpotWins')
    .sort({ jackpotBalance: -1 })
    .limit(25)
    .lean();

  const dbTotalEarned =
    (totals?.totalJackpotBalance || 0) + (totals?.totalJackpotWithdrawn || 0);
  const dbUnclaimed = totals?.totalJackpotBalance || 0;
  const dbWithdrawn = totals?.totalJackpotWithdrawn || 0;
  const onChainGap = dbWithdrawn - onChainFromLedger;
  const fundNeeded = Math.max(0, dbUnclaimed - ON_CHAIN_JACKPOT_POOL_USDC);

  const report = {
    generatedAt: new Date().toISOString(),
    dbTotals: {
      users: totals?.users || 0,
      usersWithUnclaimedBalance: totals?.usersWithBalance || 0,
      usersWhoWithdrew: totals?.usersWithWithdrawn || 0,
      totalJackpotBalanceUnclaimed: Math.round(dbUnclaimed * 1e6) / 1e6,
      totalJackpotWithdrawnDb: Math.round(dbWithdrawn * 1e6) / 1e6,
      totalLifetimeEarnedDb: Math.round(dbTotalEarned * 1e6) / 1e6,
      totalJackpotWinsCount: totals?.totalJackpotWins || 0,
    },
    freeJackpotFromPredictions: {
      totalJackpotPayoutOnFreePredictions:
        Math.round((freeJackpotEarned[0]?.totalJackpotPayout || 0) * 1e6) / 1e6,
      winningFreePredictionRows: freeJackpotEarned[0]?.predictionCount || 0,
      uniqueWinners: freeJackpotEarned[0]?.uniqueUsers?.length || 0,
    },
    onChainComparison: {
      onChainWithdrawnUsdc: onChainFromLedger,
      dbWithdrawnUsdc: Math.round(dbWithdrawn * 1e6) / 1e6,
      withdrawnDbMinusOnChain: Math.round(onChainGap * 1e6) / 1e6,
      onChainJackpotPoolRemaining: ON_CHAIN_JACKPOT_POOL_USDC,
      dbUnclaimedBalance: Math.round(dbUnclaimed * 1e6) / 1e6,
      /** Amount to fund so every DB balance can withdraw today */
      recommendedFundJackpotPoolUsdc: Math.round(fundNeeded * 1e6) / 1e6,
      note:
        'recommendedFund = max(0, sum(jackpotBalance) - on-chain jackpotPool). Add buffer for pending resolves.',
    },
    topWalletCrossCheck: walletChecks,
    topUnclaimedUsers: unclaimedUsers.map((u) => ({
      username: u.username,
      jackpotBalance: u.jackpotBalance,
      jackpotWithdrawn: u.jackpotWithdrawn,
      jackpotWins: u.jackpotWins,
      lifetimeEarned: (u.jackpotBalance || 0) + (u.jackpotWithdrawn || 0),
    })),
  };

  const outPath = path.join(__dirname, '..', 'jackpot-db-reconcile.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`\nWrote ${outPath}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
