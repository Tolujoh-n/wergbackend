const mongoose = require('mongoose');
const WalletLink = require('../models/WalletLink');
const { withOrderbookContract, withOrderbookContractOrLegacy } = require('./orderbookContractScope');

function toObjectId(userId) {
  try {
    return new mongoose.Types.ObjectId(String(userId));
  } catch {
    return null;
  }
}

/**
 * Resolve Mongo user id + linked wallet addresses for orderbook queries.
 */
async function resolveOrderbookUserScope(userId) {
  const uid = toObjectId(userId);
  if (!uid) {
    throw Object.assign(new Error('Invalid user'), { statusCode: 401 });
  }
  const links = await WalletLink.find({ user: uid }).select('walletAddress').lean();
  const wallets = [
    ...new Set(
      links
        .map((l) => String(l.walletAddress || '').trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  return { userId: uid, wallets };
}

/** User must own the row; when wallets exist, wallet must be one of theirs. */
function userOwnershipClause(scope) {
  if (!scope?.userId) return { _id: { $in: [] } };
  if (scope.wallets?.length) {
    return { user: scope.userId, walletAddress: { $in: scope.wallets } };
  }
  return { user: scope.userId };
}

function withOrderbookContractForUser(scope, extra = {}) {
  return { ...withOrderbookContract(extra), ...userOwnershipClause(scope) };
}

function withOrderbookContractOrLegacyForUser(scope, extra = {}) {
  return { ...withOrderbookContractOrLegacy(extra), ...userOwnershipClause(scope) };
}

module.exports = {
  toObjectId,
  resolveOrderbookUserScope,
  userOwnershipClause,
  withOrderbookContractForUser,
  withOrderbookContractOrLegacyForUser,
};
