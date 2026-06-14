/**
 * Clear free-prediction phone verification for a user so they can verify again.
 *
 * Usage (from backend folder):
 *   node scripts/clearPhoneVerification.js <email>
 *   node scripts/clearPhoneVerification.js <username>
 *   node scripts/clearPhoneVerification.js <userId>
 *   node scripts/clearPhoneVerification.js --phone +14155552671
 *
 * Options:
 *   --dry-run   Show what would change without saving
 *
 * Requires MONGODB_URI in backend/.env
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const User = require(path.join(__dirname, '..', 'models', 'User'));

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error('');
  console.error('Usage:');
  console.error('  node scripts/clearPhoneVerification.js <email|username|userId>');
  console.error('  node scripts/clearPhoneVerification.js --phone <E.164 number>');
  console.error('');
  console.error('Options:');
  console.error('  --dry-run   Preview only, do not save');
  process.exit(1);
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const args = argv.slice(2).filter((a) => a !== '--dry-run');

  if (args[0] === '--phone') {
    const phone = String(args[1] || '').trim();
    if (!phone) usageAndExit('Missing phone number after --phone');
    return { mode: 'phone', phone, dryRun };
  }

  const identifier = String(args[0] || '').trim();
  if (!identifier) usageAndExit('Missing user identifier');
  return { mode: 'user', identifier, dryRun };
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findUserByIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  if (!raw) return null;

  if (mongoose.Types.ObjectId.isValid(raw)) {
    const byId = await User.findById(raw);
    if (byId) return byId;
  }

  if (raw.includes('@')) {
    const safe = escapeRegExp(raw);
    const byEmail = await User.findOne({ email: new RegExp(`^${safe}$`, 'i') });
    if (byEmail) return byEmail;
  }

  const byUsername = await User.findOne({ username: raw });
  if (byUsername) return byUsername;

  if (/^\+?\d{8,15}$/.test(raw.replace(/\s/g, ''))) {
    const normalized = raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`;
    const byPhone = await User.findOne({ phone: normalized });
    if (byPhone) return byPhone;
  }

  return null;
}

function snapshotPhone(user) {
  return {
    userId: user._id.toString(),
    username: user.username,
    email: user.email || null,
    phone: user.phone || null,
    phoneVerified: !!user.phoneVerified,
    phoneVerification: user.phoneVerification
      ? {
          hasCode: !!user.phoneVerification.codeHash,
          expiresAt: user.phoneVerification.expiresAt || null,
          sentAt: user.phoneVerification.sentAt || null,
          attempts: user.phoneVerification.attempts ?? 0,
        }
      : null,
  };
}

async function clearPhoneForUser(userId) {
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        phoneVerified: false,
        phoneVerification: {
          codeHash: null,
          expiresAt: null,
          sentAt: null,
          attempts: 0,
        },
      },
      $unset: { phone: '' },
    }
  );
}

(async () => {
  const parsed = parseArgs(process.argv);
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set (backend/.env)');
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);

    let users = [];
    if (parsed.mode === 'phone') {
      users = await User.find({ phone: parsed.phone }).select(
        'username email phone phoneVerified phoneVerification'
      );
      if (!users.length) {
        console.error(`No user found with phone: ${parsed.phone}`);
        process.exit(1);
      }
    } else {
      const user = await findUserByIdentifier(parsed.identifier);
      if (!user) {
        console.error(`No user found for: ${parsed.identifier}`);
        process.exit(1);
      }
      users = [user];
    }

    for (const user of users) {
      console.log('Before:', JSON.stringify(snapshotPhone(user), null, 2));

      const hadPhone = !!(user.phone || user.phoneVerified || user.phoneVerification?.codeHash);
      if (!hadPhone) {
        console.log(`User ${user.username} (${user._id}) has no phone verification to clear.`);
        continue;
      }

      if (parsed.dryRun) {
        console.log('[dry-run] Would clear phone verification for this user.');
        continue;
      }

      await clearPhoneForUser(user._id);

      const fresh = await User.findById(user._id).select('username email phone phoneVerified phoneVerification');
      console.log('After:', JSON.stringify(snapshotPhone(fresh), null, 2));
      console.log(`Cleared phone verification for ${fresh.username} (${fresh._id}). They can verify again in the app.`);
    }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();
