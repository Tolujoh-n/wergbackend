const { ethers } = require('ethers');
const { getContractAddress } = require('./chainConfig');

/**
 * Normalized checksummed WeRgame address from env, or null.
 */
function normalizedOrderbookContractAddress() {
  const raw = getContractAddress();
  if (!raw) return null;
  try {
    return ethers.getAddress(String(raw).trim());
  } catch {
    return null;
  }
}

/** Lowercase form for Mongo storage and queries. */
function orderbookContractAddressLower() {
  const a = normalizedOrderbookContractAddress();
  return a ? a.toLowerCase() : null;
}

/**
 * Fragment `{ contractAddress: "<current>" }` so Order / positions / outbox never cross deployments.
 * If CONTRACT_ADDRESS is unset, use impossible match (orderbook stays empty rather than mixing data).
 */
function orderbookContractMatch() {
  const c = orderbookContractAddressLower();
  if (!c) return { _id: { $in: [] } };
  return { contractAddress: c };
}

function withOrderbookContract(extra) {
  return { ...orderbookContractMatch(), ...extra };
}

/**
 * Current deployment OR legacy rows with no contractAddress (pre-migration markets).
 */
function withOrderbookContractOrLegacy(extra = {}) {
  const c = orderbookContractAddressLower();
  if (!c) return { _id: { $in: [] }, ...extra };
  return {
    ...extra,
    $or: [{ contractAddress: c }, { contractAddress: null }, { contractAddress: { $exists: false } }],
  };
}

module.exports = {
  normalizedOrderbookContractAddress,
  orderbookContractAddressLower,
  orderbookContractMatch,
  withOrderbookContract,
  withOrderbookContractOrLegacy,
};
