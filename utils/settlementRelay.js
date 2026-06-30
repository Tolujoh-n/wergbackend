const { ethers } = require('ethers');
const { getWeRgameAbiSync } = require('./wergameContractAbi');
const { getWriteJsonRpcProvider, getContractAddress } = require('./chainConfig');
const { normalizePrivateKey } = require('./claimAuth');

function getSettlementWallet() {
  const pk =
    normalizePrivateKey(process.env.SETTLEMENT_RELAY_PRIVATE_KEY) ||
    normalizePrivateKey(process.env.RELAYER_PRIVATE_KEY);
  if (!pk) {
    const err = new Error('SETTLEMENT_RELAY_PRIVATE_KEY or RELAYER_PRIVATE_KEY required for on-chain settlement');
    err.statusCode = 503;
    throw err;
  }
  const provider = getWriteJsonRpcProvider();
  return new ethers.Wallet(pk, provider);
}

/**
 * @param {number} marketId
 * @param {{ user: string, positionKey: string, vaultDelta: string, sharesDelta: string, investedDelta: string }[]} legs - bigint strings for deltas
 * @param {bigint|string|number} feeToClaimPool
 * @param {bigint|string|number} feeToJackpotPool
 */
async function applyOrderbookSettlementsOnChain(marketId, legs, feeToClaimPool, feeToJackpotPool) {
  const addr = getContractAddress();
  if (!addr) {
    const err = new Error('CONTRACT_ADDRESS not configured');
    err.statusCode = 503;
    throw err;
  }
  const wallet = getSettlementWallet();
  const c = new ethers.Contract(addr, getWeRgameAbiSync(), wallet);
  const formatted = legs.map((l) => ({
    user: ethers.getAddress(l.user),
    positionKey: l.positionKey,
    vaultDelta: BigInt(l.vaultDelta),
    sharesDelta: BigInt(l.sharesDelta),
    investedDelta: BigInt(l.investedDelta),
  }));
  const feeClaim = BigInt(feeToClaimPool);
  const feeJackpot = BigInt(feeToJackpotPool == null ? '0' : String(feeToJackpotPool));
  const tx = await c.applyOrderbookSettlements(marketId, formatted, feeClaim, feeJackpot);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Post-resolution sweep: move remaining per-market vault collateral into claimPredictionWinsPool.
 */
async function finalizeResolvedMarketSettlementsOnChain(marketId, legs, collateralToClaimPool) {
  const addr = getContractAddress();
  if (!addr) {
    const err = new Error('CONTRACT_ADDRESS not configured');
    err.statusCode = 503;
    throw err;
  }
  const wallet = getSettlementWallet();
  const c = new ethers.Contract(addr, getWeRgameAbiSync(), wallet);
  const formatted = legs.map((l) => ({
    user: ethers.getAddress(l.user),
    positionKey: l.positionKey,
    vaultDelta: BigInt(l.vaultDelta),
    sharesDelta: BigInt(l.sharesDelta),
    investedDelta: BigInt(l.investedDelta),
  }));
  const tx = await c.finalizeResolvedMarketSettlements(
    marketId,
    formatted,
    BigInt(collateralToClaimPool)
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

module.exports = {
  applyOrderbookSettlementsOnChain,
  finalizeResolvedMarketSettlementsOnChain,
  getSettlementWallet,
};
