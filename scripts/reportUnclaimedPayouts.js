/**
 * Report users with unclaimed free jackpot, boost, and market payouts.
 *
 * Usage:
 *   node scripts/reportUnclaimedPayouts.js
 *   node scripts/reportUnclaimedPayouts.js --json > unclaimed.json
 *   node scripts/reportUnclaimedPayouts.js --csv > unclaimed.csv
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Prediction = require('../models/Prediction');

const AS_JSON = process.argv.includes('--json');
const AS_CSV = process.argv.includes('--csv');
const ROUND = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

function escapeCsv(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

async function loadWalletMap(userIds) {
  const links = await WalletLink.find({ user: { $in: userIds } })
    .select('user walletAddress')
    .lean();
  const map = new Map();
  for (const link of links) {
    const uid = String(link.user);
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(link.walletAddress);
  }
  return map;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const [freeRows, boostRows, marketRows] = await Promise.all([
    Prediction.find({
      type: 'free',
      status: 'won',
      jackpotPayout: { $gt: 0 },
      jackpotClaimed: { $ne: true },
    })
      .select('user jackpotPayout jackpotClaimInProgress match poll')
      .lean(),
    Prediction.find({
      type: 'boost',
      status: 'settled',
      payout: { $gt: 0 },
      claimed: { $ne: true },
    })
      .select('user payout claimInProgress match poll')
      .lean(),
    Prediction.find({
      type: 'market',
      status: 'settled',
      payout: { $gt: 0 },
      claimed: { $ne: true },
    })
      .select('user payout claimInProgress match poll')
      .lean(),
  ]);

  const userIdSet = new Set();
  for (const rows of [freeRows, boostRows, marketRows]) {
    for (const r of rows) userIdSet.add(String(r.user));
  }

  const userIds = [...userIdSet].map((id) => new mongoose.Types.ObjectId(id));
  const users = await User.find({ _id: { $in: userIds } })
    .select('username email walletAddress')
    .lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const walletMap = await loadWalletMap(userIds);

  const agg = new Map();

  function ensureRow(userId) {
    if (!agg.has(userId)) {
      const u = userById.get(userId);
      const wallets = walletMap.get(userId) || [];
      const primaryWallet =
        wallets[0] || u?.walletAddress || '';
      agg.set(userId, {
        userId,
        username: u?.username || '(deleted)',
        email: u?.email || '',
        walletAddress: primaryWallet,
        wallets: wallets.length ? wallets : primaryWallet ? [primaryWallet] : [],
        freeJackpotUnclaimed: 0,
        freeJackpotRows: 0,
        boostUnclaimed: 0,
        boostRows: 0,
        marketUnclaimed: 0,
        marketRows: 0,
      });
    }
    return agg.get(userId);
  }

  for (const p of freeRows) {
    const row = ensureRow(String(p.user));
    row.freeJackpotUnclaimed += ROUND(p.jackpotPayout);
    row.freeJackpotRows += 1;
  }
  for (const p of boostRows) {
    const row = ensureRow(String(p.user));
    row.boostUnclaimed += ROUND(p.payout);
    row.boostRows += 1;
  }
  for (const p of marketRows) {
    const row = ensureRow(String(p.user));
    row.marketUnclaimed += ROUND(p.payout);
    row.marketRows += 1;
  }

  const table = [...agg.values()].sort((a, b) => {
    const totalA = a.freeJackpotUnclaimed + a.boostUnclaimed + a.marketUnclaimed;
    const totalB = b.freeJackpotUnclaimed + b.boostUnclaimed + b.marketUnclaimed;
    return totalB - totalA || a.username.localeCompare(b.username);
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    usersWithUnclaimed: table.length,
    totals: {
      freeJackpotUsdc: ROUND(table.reduce((s, r) => s + r.freeJackpotUnclaimed, 0)),
      boostUsdc: ROUND(table.reduce((s, r) => s + r.boostUnclaimed, 0)),
      marketUsdc: ROUND(table.reduce((s, r) => s + r.marketUnclaimed, 0)),
    },
    freePredictionCount: freeRows.length,
    boostPredictionCount: boostRows.length,
    marketPredictionCount: marketRows.length,
    rows: table,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (AS_CSV) {
    console.log(
      'username,walletAddress,freeJackpotUnclaimed,boostUnclaimed,marketUnclaimed,freeRows,boostRows,marketRows,userId'
    );
    for (const r of table) {
      console.log(
        [
          escapeCsv(r.username),
          escapeCsv(r.walletAddress),
          r.freeJackpotUnclaimed,
          r.boostUnclaimed,
          r.marketUnclaimed,
          r.freeJackpotRows,
          r.boostRows,
          r.marketRows,
          r.userId,
        ].join(',')
      );
    }
  } else {
    console.log('Unclaimed payouts report');
    console.log(`Generated: ${summary.generatedAt}`);
    console.log(
      `Users: ${summary.usersWithUnclaimed} | Free jackpot: $${summary.totals.freeJackpotUsdc} (${summary.freePredictionCount} preds) | Boost: $${summary.totals.boostUsdc} (${summary.boostPredictionCount}) | Market: $${summary.totals.marketUsdc} (${summary.marketPredictionCount})`
    );
    console.log('');
    console.log(
      pad('Username', 22) +
        pad('Wallet', 44) +
        pad('Free JP', 12) +
        pad('Boost', 12) +
        pad('Market', 12)
    );
    console.log('-'.repeat(102));
    for (const r of table) {
      console.log(
        pad(r.username, 22) +
          pad(shortAddr(r.walletAddress), 44) +
          pad(fmtUsd(r.freeJackpotUnclaimed), 12) +
          pad(fmtUsd(r.boostUnclaimed), 12) +
          pad(fmtUsd(r.marketUnclaimed), 12)
      );
    }
    if (!table.length) console.log('(none)');
  }

  await mongoose.disconnect();
}

function pad(s, n) {
  const str = String(s ?? '');
  return str.length >= n ? str.slice(0, n - 1) + '…' : str.padEnd(n);
}

function shortAddr(a) {
  if (!a) return '—';
  const s = String(a);
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function fmtUsd(n) {
  const v = ROUND(n);
  return v > 0 ? `$${v.toFixed(2)}` : '—';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
