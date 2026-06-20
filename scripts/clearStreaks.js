/**
 * Reset streak rankings (user.streak + free-prediction win/loss chain).
 *
 * Streaks are computed from FREE predictions in chronological order.
 * Resetting only user.streak is not enough — won/lost free picks must be cleared too.
 *
 * Usage (from backend folder):
 *   node scripts/clearStreaks.js --dry-run
 *   node scripts/clearStreaks.js --yes
 *   node scripts/clearStreaks.js --yes --users-only
 *
 * Options:
 *   --dry-run       Preview counts only (default if --yes omitted)
 *   --yes           Apply changes (required to write)
 *   --users-only    Only zero user.streak (streak page may still show streaks until predictions reset)
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const User = require(path.join(__dirname, '..', 'models', 'User'));
const Prediction = require(path.join(__dirname, '..', 'models', 'Prediction'));

const RESOLVED_STATUSES = ['won', 'lost', 'settled'];

function parseArgs(argv) {
  const dryRun = !argv.includes('--yes');
  const usersOnly = argv.includes('--users-only');
  return { dryRun, usersOnly };
}

(async () => {
  const { dryRun, usersOnly } = parseArgs(process.argv);
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set (backend/.env)');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);

    const predFilter = {
      type: 'free',
      status: { $in: RESOLVED_STATUSES },
    };

    const [userCount, usersWithStreak, freeResolvedCount] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ streak: { $gt: 0 } }),
      Prediction.countDocuments(predFilter),
    ]);

    console.log('=== Clear streaks ===');
    console.log(`Mode: ${dryRun ? 'DRY RUN (pass --yes to apply)' : 'APPLY'}`);
    console.log(`Users-only: ${usersOnly ? 'yes' : 'no'}`);
    console.log('');
    console.log(`Users in database: ${userCount}`);
    console.log(`Users with streak > 0: ${usersWithStreak}`);
    console.log(`Resolved FREE predictions to reset: ${freeResolvedCount}`);
    console.log('');
    console.log('Will reset on all users: streak -> 0');
    if (!usersOnly) {
      console.log('Will reset free predictions: status -> pending (won/lost/settled cleared for streak math)');
      console.log('Note: payout on free picks is unchanged (usually 0). Points on User are not touched — use clearLeaderboard.js for that.');
    } else {
      console.log('Warning: --users-only does not change prediction history; /streaks may still show non-zero streaks.');
    }

    if (dryRun) {
      console.log('\n[dry-run] No changes written. Re-run with --yes to apply.');
      return;
    }

    const userResult = await User.updateMany({}, { $set: { streak: 0 } });

    let predModified = 0;
    if (!usersOnly) {
      const predResult = await Prediction.updateMany(predFilter, {
        $set: {
          status: 'pending',
          updatedAt: new Date(),
        },
      });
      predModified = predResult.modifiedCount ?? predResult.nModified ?? 0;
    }

    console.log('\nDone.');
    console.log(`Users updated: ${userResult.modifiedCount ?? userResult.nModified ?? 0}`);
    if (!usersOnly) {
      console.log(`Free predictions reset: ${predModified}`);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();
