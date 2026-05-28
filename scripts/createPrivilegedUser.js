require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  const val = process.argv[idx + 1];
  if (!val || val.startsWith('--')) return null;
  return val;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function usageAndExit(message, code = 1) {
  if (message) console.error(message);
  console.log(`
Create an admin or superAdmin user.

Usage:
  node scripts/createPrivilegedUser.js --role admin --username <username> --email <email> --password <password>
  node scripts/createPrivilegedUser.js --role superAdmin --username <username> --email <email> --password <password>

Optional:
  --walletAddress <0x...>   Set/replace wallet address
  --update                 Update role/password if user exists (by email or username)

Examples:
  node scripts/createPrivilegedUser.js --role admin --username admin2 --email admin2@wergame.com --password "StrongPass123"
  node scripts/createPrivilegedUser.js --role superAdmin --username boss --email boss@wergame.com --password "StrongPass123" --update
`);
  process.exit(code);
}

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    usageAndExit('Missing MONGODB_URI in environment.');
  }

  const role = getArg('role');
  const username = getArg('username');
  const emailRaw = getArg('email');
  const password = getArg('password');
  const walletAddress = getArg('walletAddress');
  const update = hasFlag('update');

  if (!role || !['admin', 'superAdmin'].includes(role)) {
    usageAndExit('Invalid or missing --role (must be admin or superAdmin).');
  }
  if (!username) usageAndExit('Missing --username');
  if (!emailRaw) usageAndExit('Missing --email');
  if (!password) usageAndExit('Missing --password');

  const email = String(emailRaw).trim().toLowerCase();

  await mongoose.connect(mongoUri);
  console.log('✅ Connected to MongoDB');

  const existing = await User.findOne({ $or: [{ email }, { username }] });

  if (existing && !update) {
    console.error('❌ User already exists. Re-run with --update to modify it.');
    console.log(`Found user: ${existing._id} (${existing.username}, ${existing.email}, role=${existing.role})`);
    process.exit(1);
  }

  let user = existing;
  if (!user) {
    user = new User({
      username,
      email,
      password, // hashed by pre-save hook
      role,
    });
  } else {
    user.username = username;
    user.email = email;
    user.role = role;
    user.password = password; // hashed by pre-save hook
    user.markModified('password');
  }

  if (walletAddress && String(walletAddress).trim()) {
    user.walletAddress = String(walletAddress).trim().toLowerCase();
  }

  await user.save();

  console.log('✅ Privileged user saved');
  console.log({
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    role: user.role,
    walletAddress: user.walletAddress || null,
  });

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('❌ Failed:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});

