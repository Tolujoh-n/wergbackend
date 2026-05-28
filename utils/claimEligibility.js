const { ethers } = require('ethers');

const USDC_DECIMALS = parseInt(process.env.USDC_DECIMALS || '6', 10);

/** Same rounding as frontend — matches on-chain uint256 token units. */
function payoutToWei(amount) {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid payout amount');
  }
  // USDC uses 6 decimals on Base; keep rounding stable between backend + frontend
  return ethers.parseUnits(n.toFixed(USDC_DECIMALS), USDC_DECIMALS);
}

function predictionIdToBytes32(predictionDocId) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(predictionDocId)));
}

module.exports = { payoutToWei, predictionIdToBytes32 };
