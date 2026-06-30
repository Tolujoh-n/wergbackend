const { ethers } = require('ethers');
const { getWeRgameAbiSync } = require('./wergameContractAbi');
const { getContractAddress, getReadJsonRpcProvider } = require('./chainConfig');

/**
 * Ensure the market is resolved on-chain (same as claimOrderbookPositionWithAuth).
 * We do not require on-chain shares: orderbook fills may exist only off-chain until settlement,
 * while resolved payouts are still signed from DB and paid from claimPredictionWinsPool.
 */
async function assertOrderbookClaimableOnChain({ marketId, walletAddress: _w, positionKey: _pk }) {
  const addr = getContractAddress();
  if (!addr) {
    const e = new Error('CONTRACT_ADDRESS is not configured');
    e.statusCode = 503;
    throw e;
  }

  const provider = getReadJsonRpcProvider();
  const c = new ethers.Contract(addr, getWeRgameAbiSync(), provider);
  const mid = BigInt(marketId);

  let market;
  try {
    market = await c.markets(mid);
  } catch (err) {
    const e = new Error(err.shortMessage || err.message || 'Failed to read market on-chain');
    e.statusCode = 502;
    throw e;
  }

  const resolved = market.resolved ?? market[5];
  if (!resolved) {
    const e = new Error('Market is not resolved on-chain yet');
    e.statusCode = 400;
    throw e;
  }
}

module.exports = { assertOrderbookClaimableOnChain };
