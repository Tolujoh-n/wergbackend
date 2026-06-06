const WalletLink = require('../models/WalletLink');
const OrderbookPosition = require('../models/OrderbookPosition');
const { orderbookContractAddressLower } = require('./orderbookContractScope');

function legacyContractScope(contractLower) {
  return {
    $or: [
      { contractAddress: contractLower },
      { contractAddress: null },
      { contractAddress: { $exists: false } },
    ],
  };
}

/**
 * Find all position rows for the same market/wallet/key (legacy rows may omit contractAddress).
 */
async function findPositionGroup(chainMarketId, walletAddress, positionKey, contractLower) {
  return OrderbookPosition.find({
    chainMarketId,
    walletAddress,
    positionKey,
    ...legacyContractScope(contractLower),
  }).sort({ updatedAt: -1 });
}

/**
 * Upsert one settlement leg into the off-chain position ledger without duplicate-key errors.
 */
async function applyLegToOrderbookPosition({
  chainMarketId,
  walletAddress,
  positionKey,
  contractLower,
  userId,
  matchId,
  pollId,
  sharesDelta,
  investedDelta,
}) {
  const rows = await findPositionGroup(chainMarketId, walletAddress, positionKey, contractLower);

  const setFields = {
    user: userId,
    contractAddress: contractLower,
    updatedAt: new Date(),
    ...(matchId ? { match: matchId } : {}),
    ...(pollId ? { poll: pollId } : {}),
  };

  if (rows.length > 1) {
    let shares = sharesDelta;
    let totalInvested = investedDelta;
    for (const r of rows) {
      shares += Number(r.shares) || 0;
      totalInvested += Number(r.totalInvested) || 0;
    }
    await OrderbookPosition.deleteMany({ _id: { $in: rows.map((r) => r._id) } });
    await OrderbookPosition.create({
      chainMarketId,
      walletAddress,
      positionKey,
      contractAddress: contractLower,
      user: userId,
      shares,
      totalInvested,
      updatedAt: new Date(),
      ...(matchId ? { match: matchId } : {}),
      ...(pollId ? { poll: pollId } : {}),
    });
    return;
  }

  if (rows.length === 1) {
    await OrderbookPosition.updateOne(
      { _id: rows[0]._id },
      {
        $inc: { shares: sharesDelta, totalInvested: investedDelta },
        $set: setFields,
      }
    );
    return;
  }

  await OrderbookPosition.create({
    chainMarketId,
    walletAddress,
    positionKey,
    contractAddress: contractLower,
    user: userId,
    shares: sharesDelta,
    totalInvested: investedDelta,
    updatedAt: new Date(),
    ...(matchId ? { match: matchId } : {}),
    ...(pollId ? { poll: pollId } : {}),
  });
}

/**
 * Merge duplicate legacy rows and backfill contractAddress; drop obsolete unique index if present.
 */
async function migrateOrderbookPositionLedger() {
  const contractLower = orderbookContractAddressLower();
  if (!contractLower) return;

  const coll = OrderbookPosition.collection;
  const indexes = await coll.indexes();
  const legacyIdx = indexes.find((i) => i.name === 'chainMarketId_1_walletAddress_1_positionKey_1');
  if (legacyIdx) {
    try {
      await coll.dropIndex('chainMarketId_1_walletAddress_1_positionKey_1');
      console.log('[orderbook] dropped legacy orderbookpositions index chainMarketId_1_walletAddress_1_positionKey_1');
    } catch (e) {
      console.warn('[orderbook] could not drop legacy index:', e.message || e);
    }
  }

  const dupGroups = await OrderbookPosition.aggregate([
    {
      $group: {
        _id: {
          chainMarketId: '$chainMarketId',
          walletAddress: '$walletAddress',
          positionKey: '$positionKey',
        },
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  for (const g of dupGroups) {
    const docs = await OrderbookPosition.find({ _id: { $in: g.ids } });
    if (docs.length < 2) continue;
    let shares = 0;
    let totalInvested = 0;
    let user = docs[0].user;
    let match = docs[0].match;
    let poll = docs[0].poll;
    for (const d of docs) {
      shares += Number(d.shares) || 0;
      totalInvested += Number(d.totalInvested) || 0;
      if (!user && d.user) user = d.user;
      if (!match && d.match) match = d.match;
      if (!poll && d.poll) poll = d.poll;
    }
    await OrderbookPosition.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
    await OrderbookPosition.create({
      chainMarketId: g._id.chainMarketId,
      walletAddress: g._id.walletAddress,
      positionKey: g._id.positionKey,
      contractAddress: contractLower,
      user,
      match,
      poll,
      shares,
      totalInvested,
      updatedAt: new Date(),
    });
    console.log(
      `[orderbook] merged ${docs.length} duplicate positions for ${g._id.walletAddress} ${g._id.positionKey}`
    );
  }

  await OrderbookPosition.updateMany(
    {
      $or: [{ contractAddress: null }, { contractAddress: { $exists: false } }],
    },
    { $set: { contractAddress: contractLower } }
  );

  try {
    await OrderbookPosition.syncIndexes();
  } catch (e) {
    console.warn('[orderbook] syncIndexes:', e.message || e);
  }
}

module.exports = {
  applyLegToOrderbookPosition,
  migrateOrderbookPositionLedger,
  legacyContractScope,
};
