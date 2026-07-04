/**
 * One-time reconciliation: align MongoDB claim state with on-chain reality.
 *
 * - Free jackpot: set user jackpotBalance / jackpotWithdrawn from earned vs JackpotWithdrawn events;
 *   mark per-prediction jackpotClaimed (FIFO).
 * - Boost / market: mark prediction.claimed when usedAuthPredictionClaims / usedOrderbookClaimKeys is true on-chain.
 * - Optional: sync on-chain jackpotBalances mapping after DB fix.
 *
 * Usage:
 *   node scripts/reconcileClaimsFromChain.js              # dry-run (report only)
 *   node scripts/reconcileClaimsFromChain.js --apply       # write DB updates
 *   node scripts/reconcileClaimsFromChain.js --apply --sync-on-chain
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { ethers } = require('ethers');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const Prediction = require('../models/Prediction');
const { ProcessedTx } = require('../utils/processedTx');
const { predictionIdToBytes32 } = require('../utils/claimEligibility');
const { getWeRgameAbiSync } = require('../utils/wergameContractAbi');
const { getReadJsonRpcProvider, getContractAddress } = require('../utils/chainConfig');
const { batchSetJackpotBalancesOnChain } = require('../utils/jackpotOnChainSync');

const APPLY = process.argv.includes('--apply');
const SYNC_ON_CHAIN = process.argv.includes('--sync-on-chain');
const USE_LEDGER = !process.argv.includes('--fetch-chain');

const DEPLOY_BLOCK = parseInt(process.env.WERGAME_DEPLOY_BLOCK || '47002945', 10);
const ROUND = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(addr) {
  return String(addr || '').trim().toLowerCase();
}

function authKeyAmmBoost(wallet, predictionMongoId) {
  const predictionId = predictionIdToBytes32(String(predictionMongoId));
  return ethers.solidityPackedKeccak256(['address', 'bytes32'], [ethers.getAddress(wallet), predictionId]);
}

function authKeyOrderbook(wallet, predictionMongoId) {
  const predictionId = predictionIdToBytes32(String(predictionMongoId));
  return ethers.solidityPackedKeccak256(
    ['address', 'bytes32', 'uint256'],
    [ethers.getAddress(wallet), predictionId, 2n]
  );
}

function loadJackpotWithdrawalsFromLedger() {
  const ledgerPath = path.join(__dirname, '..', 'jackpot-ledger-report.json');
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`Missing ${ledgerPath}. Run: node scripts/fetchJackpotLedger.js`);
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const byWallet = new Map();
  for (const row of ledger.rows || []) {
    if (row.type !== 'JackpotWithdrawn' || !row.wallet) continue;
    const w = norm(row.wallet);
    const amt = parseFloat(row.amountUsdc) || 0;
    if (!byWallet.has(w)) byWallet.set(w, { total: 0, events: [] });
    const entry = byWallet.get(w);
    entry.total += amt;
    entry.events.push({
      amountUsdc: amt,
      txHash: row.txHash,
      time: row.time,
      block: row.block,
    });
  }
  return { byWallet, source: ledgerPath };
}

async function fetchJackpotWithdrawalsFromChain(provider, contractAddress) {
  const iface = new ethers.Interface([
    'event JackpotWithdrawn(address indexed user, uint256 amount)',
  ]);
  const topic = ethers.id('JackpotWithdrawn(address,uint256)');
  const latest = await provider.getBlockNumber();
  const CHUNK = 9999;
  const logs = [];
  for (let start = DEPLOY_BLOCK; start <= latest; start += CHUNK + 1) {
    const end = Math.min(start + CHUNK, latest);
    let part = [];
    for (let t = 0; t < 5; t += 1) {
      try {
        part = await provider.getLogs({
          address: contractAddress,
          fromBlock: start,
          toBlock: end,
          topics: [topic],
        });
        break;
      } catch (e) {
        await sleep(600 * (t + 1));
        if (t === 4) throw e;
      }
    }
    logs.push(...part);
    process.stderr.write(`  jackpot blocks ${start}-${end}: +${part.length}\n`);
    await sleep(100);
  }
  const byWallet = new Map();
  for (const log of logs) {
    const p = iface.parseLog(log);
    const w = norm(p.args.user);
    const amt = parseFloat(ethers.formatUnits(p.args.amount, 6));
    if (!byWallet.has(w)) byWallet.set(w, { total: 0, events: [] });
    const entry = byWallet.get(w);
    entry.total += amt;
    entry.events.push({
      amountUsdc: amt,
      txHash: log.transactionHash,
      block: log.blockNumber,
    });
  }
  return { byWallet, source: 'chain' };
}

async function buildWalletUserMaps() {
  const links = await WalletLink.find({}).lean();
  const walletToUser = new Map();
  const userToWallet = new Map();
  for (const l of links) {
    const w = norm(l.walletAddress);
    const uid = String(l.user);
    walletToUser.set(w, uid);
    if (!userToWallet.has(uid)) userToWallet.set(uid, w);
  }
  const usersWithWalletField = await User.find({ walletAddress: { $exists: true, $ne: '' } })
    .select('_id walletAddress')
    .lean();
  for (const u of usersWithWalletField) {
    const w = norm(u.walletAddress);
    const uid = String(u._id);
    if (w && !walletToUser.has(w)) walletToUser.set(w, uid);
    if (!userToWallet.has(uid) && w) userToWallet.set(uid, w);
  }
  return { walletToUser, userToWallet };
}

function fifoJackpotClaims(predictions, withdrawnTotal) {
  const sorted = [...predictions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  let remaining = withdrawnTotal;
  const marks = [];
  for (const p of sorted) {
    const amt = Number(p.jackpotPayout) || 0;
    if (!(amt > 0)) continue;
    if (remaining + 1e-6 >= amt) {
      marks.push({ predictionId: String(p._id), amount: amt, claimed: true });
      remaining -= amt;
    } else {
      marks.push({ predictionId: String(p._id), amount: amt, claimed: false });
    }
  }
  return { marks, unallocatedWithdrawn: ROUND(Math.max(0, remaining)) };
}

async function reconcileJackpotUsers({ byWallet, userToWallet, walletToUser }) {
  const userIds = new Set();
  const freeEarnedAgg = await Prediction.aggregate([
    { $match: { type: 'free', status: 'won', jackpotPayout: { $gt: 0 } } },
    {
      $group: {
        _id: '$user',
        earned: { $sum: '$jackpotPayout' },
        count: { $sum: 1 },
      },
    },
  ]);
  for (const row of freeEarnedAgg) userIds.add(String(row._id));
  for (const uid of userToWallet.keys()) userIds.add(uid);
  for (const uid of walletToUser.values()) userIds.add(uid);

  const earnedByUser = new Map(freeEarnedAgg.map((r) => [String(r._id), ROUND(r.earned)]));
  const users = await User.find({ _id: { $in: [...userIds] } })
    .select('username jackpotBalance jackpotWithdrawn jackpotBalancePending jackpotWithdrawInProgress')
    .lean();

  const updates = [];
  const predictionUpdates = [];
  const processedTxInserts = [];
  const rows = [];

  for (const user of users) {
    const uid = String(user._id);
    const wallet = userToWallet.get(uid);
    const earned = earnedByUser.get(uid) || 0;
    const chainEntry = wallet ? byWallet.get(norm(wallet)) : null;
    const onChainWithdrawn = ROUND(chainEntry?.total || 0);

    const correctWithdrawn = ROUND(Math.min(earned, onChainWithdrawn));
    const correctBalance = ROUND(Math.max(0, earned - onChainWithdrawn));
    const overWithdrawn = onChainWithdrawn > earned + 1e-6;

    const before = {
      jackpotBalance: ROUND(user.jackpotBalance),
      jackpotWithdrawn: ROUND(user.jackpotWithdrawn),
      jackpotBalancePending: ROUND(user.jackpotBalancePending),
    };

    const changed =
      before.jackpotBalance !== correctBalance ||
      before.jackpotWithdrawn !== correctWithdrawn ||
      before.jackpotBalancePending !== 0;

    const freePreds = await Prediction.find({
      user: user._id,
      type: 'free',
      status: 'won',
      jackpotPayout: { $gt: 0 },
    })
      .select('_id jackpotPayout jackpotClaimed createdAt')
      .lean();

    const { marks } = fifoJackpotClaims(freePreds, correctWithdrawn);
    const predChanges = [];
    for (const m of marks) {
      const pred = freePreds.find((p) => String(p._id) === m.predictionId);
      if (!pred) continue;
      if (pred.jackpotClaimed === m.claimed) continue;
      predChanges.push(m);
      predictionUpdates.push({
        updateOne: {
          filter: { _id: m.predictionId },
          update: {
            $set: {
              jackpotClaimed: m.claimed,
              jackpotClaimInProgress: false,
              ...(m.claimed && chainEntry?.events?.[0]?.txHash
                ? { jackpotClaimTxHash: chainEntry.events[0].txHash }
                : {}),
            },
          },
        },
      });
    }

    if (changed) {
      updates.push({
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: {
              jackpotBalance: correctBalance,
              jackpotWithdrawn: correctWithdrawn,
              jackpotBalancePending: 0,
              jackpotWithdrawInProgress: false,
            },
          },
        },
      });
    }

    if (chainEntry?.events?.length) {
      for (const ev of chainEntry.events) {
        if (!ev.txHash) continue;
        processedTxInserts.push({
          scope: 'jackpot_withdraw',
          txHash: norm(ev.txHash),
          user: user._id,
          amount: ev.amountUsdc,
          meta: { reconciled: true, source: 'reconcileClaimsFromChain' },
        });
      }
    }

    if (changed || predChanges.length || overWithdrawn) {
      rows.push({
        userId: uid,
        username: user.username,
        wallet: wallet || null,
        earned,
        onChainWithdrawn,
        overWithdrawnOnChain: overWithdrawn,
        before,
        after: {
          jackpotBalance: correctBalance,
          jackpotWithdrawn: correctWithdrawn,
          jackpotBalancePending: 0,
        },
        predictionsMarkedClaimed: predChanges.filter((m) => m.claimed).length,
        predictionsMarkedUnclaimed: predChanges.filter((m) => !m.claimed).length,
      });
    }
  }

  return { updates, predictionUpdates, processedTxInserts, rows };
}

async function reconcileBoostMarketOnChain(contract) {
  const preds = await Prediction.find({
    type: { $in: ['boost', 'market'] },
    status: 'settled',
    payout: { $gt: 0 },
    claimed: { $ne: true },
  })
    .select('_id user type payout walletAddress marketChannel outcome')
    .lean();

  const links = await WalletLink.find({}).lean();
  const walletByUser = new Map(links.map((l) => [String(l.user), l.walletAddress]));
  const users = await User.find({
    _id: { $in: preds.map((p) => p.user).filter(Boolean) },
  })
    .select('walletAddress')
    .lean();
  for (const u of users) {
    if (u.walletAddress && !walletByUser.has(String(u._id))) {
      walletByUser.set(String(u._id), u.walletAddress);
    }
  }

  const updates = [];
  const rows = [];
  const BATCH = 8;

  for (let i = 0; i < preds.length; i += BATCH) {
    const slice = preds.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (p) => {
        const wallet =
          p.walletAddress ||
          walletByUser.get(String(p.user)) ||
          null;
        if (!wallet) {
          rows.push({
            predictionId: String(p._id),
            type: p.type,
            payout: p.payout,
            skipped: 'no_wallet',
          });
          return;
        }
        let walletAddr;
        try {
          walletAddr = ethers.getAddress(wallet);
        } catch {
          rows.push({
            predictionId: String(p._id),
            skipped: 'invalid_wallet',
            wallet,
          });
          return;
        }

        const isOrderbook =
          p.type === 'market' &&
          (p.marketChannel === 'orderbook' || String(p.outcome || '').includes('|'));
        const key = isOrderbook
          ? authKeyOrderbook(walletAddr, p._id)
          : authKeyAmmBoost(walletAddr, p._id);

        let used = false;
        try {
          used = isOrderbook
            ? await contract.usedOrderbookClaimKeys(key)
            : await contract.usedAuthPredictionClaims(key);
        } catch (e) {
          rows.push({
            predictionId: String(p._id),
            error: e?.message || String(e),
          });
          return;
        }

        if (!used) return;

        updates.push({
          updateOne: {
            filter: { _id: p._id, claimed: { $ne: true } },
            update: {
              $set: {
                claimed: true,
                claimInProgress: false,
              },
            },
          },
        });
        rows.push({
          predictionId: String(p._id),
          type: p.type,
          payout: ROUND(p.payout),
          wallet: walletAddr,
          markedClaimed: true,
          channel: isOrderbook ? 'orderbook' : 'amm_boost',
        });
      })
    );
    if (i + BATCH < preds.length) await sleep(150);
  }

  return { updates, rows };
}

async function clearStaleLocks() {
  const [users, preds] = await Promise.all([
    User.updateMany(
      { $or: [{ jackpotWithdrawInProgress: true }, { jackpotBalancePending: { $gt: 0 } }] },
      { $set: { jackpotWithdrawInProgress: false, jackpotBalancePending: 0 } }
    ),
    Prediction.updateMany(
      {
        $or: [
          { jackpotClaimInProgress: true },
          { claimInProgress: true },
        ],
      },
      { $set: { jackpotClaimInProgress: false, claimInProgress: false } }
    ),
  ]);
  return { usersModified: users.modifiedCount, predictionsModified: preds.modifiedCount };
}

async function insertProcessedTxUnique(docs) {
  let inserted = 0;
  let skipped = 0;
  for (const doc of docs) {
    try {
      await ProcessedTx.create(doc);
      inserted += 1;
    } catch (e) {
      if (e?.code === 11000) skipped += 1;
      else throw e;
    }
  }
  return { inserted, skipped };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set');

  const contractAddress = getContractAddress();
  if (!contractAddress) throw new Error('CONTRACT_ADDRESS not set');

  await mongoose.connect(uri);
  process.stderr.write(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}${SYNC_ON_CHAIN ? ' + sync-on-chain' : ''}\n`);

  const provider = getReadJsonRpcProvider();
  const contract = new ethers.Contract(contractAddress, getWeRgameAbiSync(), provider);

  let jackpotSource;
  let byWallet;
  if (USE_LEDGER) {
    try {
      ({ byWallet, source: jackpotSource } = loadJackpotWithdrawalsFromLedger());
      process.stderr.write(`Loaded jackpot withdrawals from ledger (${byWallet.size} wallets)\n`);
    } catch (e) {
      process.stderr.write(`Ledger load failed (${e.message}); fetching from chain…\n`);
      ({ byWallet, source: jackpotSource } = await fetchJackpotWithdrawalsFromChain(
        provider,
        contractAddress
      ));
    }
  } else {
    ({ byWallet, source: jackpotSource } = await fetchJackpotWithdrawalsFromChain(
      provider,
      contractAddress
    ));
  }

  const { walletToUser, userToWallet } = await buildWalletUserMaps();

  const jackpot = await reconcileJackpotUsers({ byWallet, userToWallet, walletToUser });
  process.stderr.write(
    `Jackpot: ${jackpot.rows.length} users to adjust, ${jackpot.predictionUpdates.length} prediction rows\n`
  );

  const boostMarket = await reconcileBoostMarketOnChain(contract);
  process.stderr.write(
    `Boost/market: ${boostMarket.updates.length} predictions to mark claimed on-chain\n`
  );

  const report = {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    contractAddress,
    jackpotWithdrawalSource: jackpotSource,
    summary: {
      jackpotUsersAdjusted: jackpot.updates.length,
      jackpotPredictionsUpdated: jackpot.predictionUpdates.length,
      boostMarketPredictionsMarkedClaimed: boostMarket.updates.length,
      jackpotProcessedTxToRegister: jackpot.processedTxInserts.length,
      walletsOverWithdrawnOnChain: jackpot.rows.filter((r) => r.overWithdrawnOnChain).length,
    },
    jackpotUsers: jackpot.rows,
    boostMarketClaims: boostMarket.rows.filter((r) => r.markedClaimed || r.skipped),
  };

  if (APPLY) {
    const locks = await clearStaleLocks();
    report.locksCleared = locks;

    if (jackpot.updates.length) {
      await User.bulkWrite(jackpot.updates, { ordered: false });
    }
    if (jackpot.predictionUpdates.length) {
      await Prediction.bulkWrite(jackpot.predictionUpdates, { ordered: false });
    }
    if (boostMarket.updates.length) {
      await Prediction.bulkWrite(boostMarket.updates, { ordered: false });
    }
    report.processedTx = await insertProcessedTxUnique(jackpot.processedTxInserts);

    if (SYNC_ON_CHAIN) {
      const userIds = jackpot.rows.map((r) => r.userId);
      const users = await User.find({ _id: { $in: userIds } })
        .select('jackpotBalance jackpotBalancePending')
        .lean();
      const links = await WalletLink.find({ user: { $in: userIds } }).lean();
      const walletByUser = new Map(links.map((l) => [String(l.user), l.walletAddress]));
      const entries = [];
      for (const u of users) {
        const w = walletByUser.get(String(u._id));
        if (!w) continue;
        const bal =
          Math.max(0, Number(u.jackpotBalance) || 0) +
          Math.max(0, Number(u.jackpotBalancePending) || 0);
        if (bal > 0 || jackpot.rows.some((r) => r.userId === String(u._id))) {
          entries.push({ walletAddress: w, balanceUsdc: bal });
        }
      }
      if (entries.length) {
        try {
          const txHash = await batchSetJackpotBalancesOnChain(entries);
          report.onChainJackpotSync = { wallets: entries.length, txHash };
        } catch (e) {
          report.onChainJackpotSync = { error: e?.message || String(e) };
        }
      }
    }
  }

  const outPath = path.join(__dirname, '..', 'reconcile-claims-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  process.stderr.write(`\nWrote ${outPath}\n`);
  if (!APPLY) {
    process.stderr.write('\nDry-run only. Re-run with --apply to write changes.\n');
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
