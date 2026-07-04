/**
 * Report unresolved matches/polls and active boost + free predictions on them.
 *
 * Usage:
 *   node scripts/reportOpenPredictions.js
 *   node scripts/reportOpenPredictions.js --json > open-predictions.json
 *   node scripts/reportOpenPredictions.js --csv > open-predictions.csv
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Prediction = require('../models/Prediction');
const Match = require('../models/Match');
const Poll = require('../models/Poll');

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

function matchLabel(m) {
  return `${m.teamA} vs ${m.teamB}`;
}

function pollLabel(p) {
  const q = String(p.question || '').trim();
  return q.length > 60 ? `${q.slice(0, 57)}…` : q;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const [openMatches, openPolls] = await Promise.all([
    Match.find({ isResolved: { $ne: true } })
      .select('teamA teamB date status isResolved marketId')
      .sort({ date: 1 })
      .lean(),
    Poll.find({ isResolved: { $ne: true } })
      .select('question date status isResolved marketId type')
      .sort({ date: 1 })
      .lean(),
  ]);

  const matchIds = openMatches.map((m) => m._id);
  const pollIds = openPolls.map((p) => p._id);

  const [boostPreds, freePreds] = await Promise.all([
    Prediction.find({
      type: 'boost',
      $and: [
        { $or: [{ match: { $in: matchIds } }, { poll: { $in: pollIds } }] },
        {
          $or: [
            { totalStake: { $gt: 0 } },
            { amount: { $gt: 0 } },
            { originalStake: { $gt: 0 } },
          ],
        },
      ],
    })
      .select('user match poll outcome totalStake amount originalStake walletAddress status')
      .lean(),
    Prediction.find({
      type: 'free',
      $or: [{ match: { $in: matchIds } }, { poll: { $in: pollIds } }],
      ticketsStaked: { $gte: 1 },
    })
      .select('user match poll outcome ticketsStaked walletAddress status')
      .lean(),
  ]);

  const userIdSet = new Set();
  for (const p of [...boostPreds, ...freePreds]) {
    userIdSet.add(String(p.user));
  }
  const userIds = [...userIdSet].map((id) => new mongoose.Types.ObjectId(id));
  const users = await User.find({ _id: { $in: userIds } })
    .select('username walletAddress')
    .lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const walletMap = await loadWalletMap(userIds);

  function userInfo(userId, predWallet) {
    const u = userById.get(userId);
    const wallets = walletMap.get(userId) || [];
    const wallet = wallets[0] || u?.walletAddress || predWallet || '';
    return {
      username: u?.username || '(deleted)',
      walletAddress: wallet,
    };
  }

  function boostStake(p) {
    return ROUND(p.totalStake || p.amount || p.originalStake || 0);
  }

  const items = [];

  for (const m of openMatches) {
    const id = String(m._id);
    const boost = boostPreds
      .filter((p) => p.match && String(p.match) === id)
      .map((p) => {
        const ui = userInfo(String(p.user), p.walletAddress);
        return {
          username: ui.username,
          walletAddress: ui.walletAddress,
          outcome: p.outcome,
          stakeUsdc: boostStake(p),
          status: p.status,
        };
      });
    const free = freePreds
      .filter((p) => p.match && String(p.match) === id)
      .map((p) => {
        const ui = userInfo(String(p.user), p.walletAddress);
        return {
          username: ui.username,
          walletAddress: ui.walletAddress,
          outcome: p.outcome,
          tickets: Number(p.ticketsStaked) || 1,
          status: p.status,
        };
      });
    items.push({
      kind: 'match',
      itemId: id,
      label: matchLabel(m),
      date: m.date,
      status: m.status,
      marketId: m.marketId ?? null,
      boostPredictions: boost,
      freePredictions: free,
      boostTotalUsdc: ROUND(boost.reduce((s, b) => s + b.stakeUsdc, 0)),
      freeTotalTickets: free.reduce((s, f) => s + f.tickets, 0),
    });
  }

  for (const p of openPolls) {
    const id = String(p._id);
    const boost = boostPreds
      .filter((pred) => pred.poll && String(pred.poll) === id)
      .map((pred) => {
        const ui = userInfo(String(pred.user), pred.walletAddress);
        return {
          username: ui.username,
          walletAddress: ui.walletAddress,
          outcome: pred.outcome,
          stakeUsdc: boostStake(pred),
          status: pred.status,
        };
      });
    const free = freePreds
      .filter((pred) => pred.poll && String(pred.poll) === id)
      .map((pred) => {
        const ui = userInfo(String(pred.user), pred.walletAddress);
        return {
          username: ui.username,
          walletAddress: ui.walletAddress,
          outcome: pred.outcome,
          tickets: Number(pred.ticketsStaked) || 1,
          status: pred.status,
        };
      });
    items.push({
      kind: 'poll',
      itemId: id,
      label: pollLabel(p),
      date: p.date,
      status: p.status,
      marketId: p.marketId ?? null,
      boostPredictions: boost,
      freePredictions: free,
      boostTotalUsdc: ROUND(boost.reduce((s, b) => s + b.stakeUsdc, 0)),
      freeTotalTickets: free.reduce((s, f) => s + f.tickets, 0),
    });
  }

  const withActivity = items.filter(
    (i) => i.boostPredictions.length > 0 || i.freePredictions.length > 0
  );
  const emptyOpen = items.filter(
    (i) => i.boostPredictions.length === 0 && i.freePredictions.length === 0
  );

  const summary = {
    generatedAt: new Date().toISOString(),
    openMatches: openMatches.length,
    openPolls: openPolls.length,
    itemsWithPredictions: withActivity.length,
    openItemsWithNoPredictions: emptyOpen.length,
    items: withActivity,
    openItemsWithNoPredictionsList: emptyOpen.map((i) => ({
      kind: i.kind,
      itemId: i.itemId,
      label: i.label,
      status: i.status,
    })),
  };

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (AS_CSV) {
    console.log(
      'kind,itemId,label,predictionType,username,walletAddress,outcome,amount,tickets,status'
    );
    for (const item of withActivity) {
      for (const b of item.boostPredictions) {
        console.log(
          [
            item.kind,
            item.itemId,
            escapeCsv(item.label),
            'boost',
            escapeCsv(b.username),
            escapeCsv(b.walletAddress),
            escapeCsv(b.outcome),
            b.stakeUsdc,
            '',
            b.status,
          ].join(',')
        );
      }
      for (const f of item.freePredictions) {
        console.log(
          [
            item.kind,
            item.itemId,
            escapeCsv(item.label),
            'free',
            escapeCsv(f.username),
            escapeCsv(f.walletAddress),
            escapeCsv(f.outcome),
            '',
            f.tickets,
            f.status,
          ].join(',')
        );
      }
    }
  } else {
    console.log('Open (unresolved) matches/polls — boost & free predictions');
    console.log(`Generated: ${summary.generatedAt}`);
    console.log(
      `Open: ${summary.openMatches} matches, ${summary.openPolls} polls | With predictions: ${summary.itemsWithPredictions} | Empty open items: ${summary.openItemsWithNoPredictions}`
    );
    console.log('');

    for (const item of withActivity) {
      console.log('='.repeat(100));
      console.log(
        `[${item.kind.toUpperCase()}] ${item.itemId} | ${item.label} | status=${item.status} | marketId=${item.marketId ?? '—'}`
      );
      if (item.date) console.log(`  Date: ${new Date(item.date).toISOString()}`);

      if (item.boostPredictions.length) {
        console.log(`  BOOST (${item.boostPredictions.length} users, $${item.boostTotalUsdc.toFixed(2)} total):`);
        console.log(
          '    ' +
            pad('Username', 20) +
            pad('Wallet', 44) +
            pad('Outcome', 16) +
            pad('Stake', 10) +
            'Status'
        );
        for (const b of item.boostPredictions) {
          console.log(
            '    ' +
              pad(b.username, 20) +
              pad(shortAddr(b.walletAddress), 44) +
              pad(b.outcome, 16) +
              pad(`$${b.stakeUsdc.toFixed(2)}`, 10) +
              b.status
          );
        }
      } else {
        console.log('  BOOST: (none)');
      }

      if (item.freePredictions.length) {
        console.log(`  FREE (${item.freePredictions.length} users, ${item.freeTotalTickets} tickets total):`);
        console.log(
          '    ' +
            pad('Username', 20) +
            pad('Wallet', 44) +
            pad('Outcome', 16) +
            pad('Tickets', 10) +
            'Status'
        );
        for (const f of item.freePredictions) {
          console.log(
            '    ' +
              pad(f.username, 20) +
              pad(shortAddr(f.walletAddress), 44) +
              pad(f.outcome, 16) +
              pad(String(f.tickets), 10) +
              f.status
          );
        }
      } else {
        console.log('  FREE: (none)');
      }
      console.log('');
    }

    if (!withActivity.length) {
      console.log('No boost or free predictions on unresolved items.');
    }
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
