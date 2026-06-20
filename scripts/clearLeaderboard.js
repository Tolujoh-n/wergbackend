/**
 * Reset leaderboard rankings (user stats + resolved prediction scores).
 *
 * Leaderboard scores are computed from Prediction documents (won/lost + payout),
 * not only User.points. This script zeros both so the board starts fresh.
 *
 * Usage (from backend folder):
 *   node scripts/clearLeaderboard.js --dry-run
 *   node scripts/clearLeaderboard.js --yes
 *   node scripts/clearLeaderboard.js --yes --type free
 *
 * Options:
 *   --dry-run       Preview counts only (default if --yes omitted)
 *   --yes           Apply changes (required to write)
 *   --type <t>      all | free | boost | market (default: all)
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const User = require(path.join(__dirname, '..', 'models', 'User'));
const Prediction = require(path.join(__dirname, '..', 'models', 'Prediction'));

const RESOLVED_STATUSES = ['won', 'lost', 'settled'];

function parseArgs(argv) {
  const dryRun = !argv.includes('--yes');
  const typeIdx = argv.indexOf('--type');
  let type = 'all';
  if (typeIdx !== -1) {
    type = String(argv[typeIdx + 1] || 'all').toLowerCase();
  }
  if (!['all', 'free', 'boost', 'market'].includes(type)) {
    console.error('Invalid --type. Use: all, free, boost, or market');
    process.exit(1);
  }
  return { dryRun, type };
}

function predictionFilter(type) {
  const base = { status: { $in: RESOLVED_STATUSES } };
  if (type === 'all') return base;
  return { ...base, type };
}

(async () => {
  const { dryRun, type } = parseArgs(process.argv);
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set (backend/.env)');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);

    const predFilter = predictionFilter(type);
    const [userCount, predCount, usersWithPoints] = await Promise.all([
      User.countDocuments({}),
      Prediction.countDocuments(predFilter),
      User.countDocuments({
        $or: [
          { points: { $gt: 0 } },
          { correctPredictions: { $gt: 0 } },
          { totalPredictions: { $gt: 0 } },
        ],
      }),
    ]);

    console.log('=== Clear leaderboard ===');
    console.log(`Mode: ${dryRun ? 'DRY RUN (pass --yes to apply)' : 'APPLY'}`);
    console.log(`Prediction scope: ${type}`);
    console.log('');
    console.log(`Users in database: ${userCount}`);
    console.log(`Users with cached points/stats: ${usersWithPoints}`);
    console.log(`Resolved predictions to reset (${type}): ${predCount}`);
    console.log('');
    console.log('Will reset on all users: points, correctPredictions, totalPredictions, streak');
    console.log('Will reset matching predictions: status -> pending, payout -> 0, claimed -> false');

    if (dryRun) {
      console.log('\n[dry-run] No changes written. Re-run with --yes to apply.');
      return;
    }

    const userResult = await User.updateMany(
      {},
      {
        $set: {
          points: 0,
          correctPredictions: 0,
          totalPredictions: 0,
          streak: 0,
        },
      }
    );

    const predResult = await Prediction.updateMany(predFilter, {
      $set: {
        status: 'pending',
        payout: 0,
        claimed: false,
        updatedAt: new Date(),
      },
    });

    console.log('\nDone.');
    console.log(`Users updated: ${userResult.modifiedCount ?? userResult.nModified ?? 0}`);
    console.log(`Predictions reset: ${predResult.modifiedCount ?? predResult.nModified ?? 0}`);
    console.log('Leaderboard and streak pages will show empty/zero until new results are recorded.');
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();
