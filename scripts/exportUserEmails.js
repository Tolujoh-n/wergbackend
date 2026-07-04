/**
 * Export all platform user emails to JSON.
 *
 * Usage:
 *   node scripts/exportUserEmails.js
 *   node scripts/exportUserEmails.js --out exports/user-emails.json
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');

const OUT_FLAG = process.argv.indexOf('--out');
const outArg = OUT_FLAG >= 0 ? process.argv[OUT_FLAG + 1] : null;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const users = await User.find({})
    .select('username email emailVerified walletAddress createdAt')
    .sort({ username: 1 })
    .lean();

  const userIds = users.map((u) => u._id);
  const links = await WalletLink.find({ user: { $in: userIds } })
    .select('user walletAddress')
    .lean();

  const walletsByUser = new Map();
  for (const link of links) {
    const uid = String(link.user);
    if (!walletsByUser.has(uid)) walletsByUser.set(uid, []);
    walletsByUser.get(uid).push(link.walletAddress);
  }

  const emails = users.map((u) => u.email).filter(Boolean);
  const withWallet = users.filter((u) => {
    const linked = walletsByUser.get(String(u._id)) || [];
    return Boolean(u.walletAddress || linked.length);
  }).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    totalUsers: users.length,
    withEmail: emails.length,
    withoutEmail: users.length - emails.length,
    withWallet,
    withoutWallet: users.length - withWallet,
    emails,
    users: users.map((u) => {
      const linked = walletsByUser.get(String(u._id)) || [];
      const walletAddress = linked[0] || u.walletAddress || null;
      const walletAddresses = linked.length
        ? linked
        : u.walletAddress
          ? [u.walletAddress]
          : [];
      return {
        username: u.username,
        email: u.email || null,
        emailVerified: Boolean(u.emailVerified),
        walletAddress,
        walletAddresses,
        createdAt: u.createdAt,
      };
    }),
  };

  const outPath = path.resolve(
    outArg || path.join(__dirname, '..', 'exports', 'user-emails.json')
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  console.log(`Wrote ${outPath}`);
  console.log(`Users: ${payload.totalUsers} | With email: ${payload.withEmail} | With wallet: ${payload.withWallet}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
