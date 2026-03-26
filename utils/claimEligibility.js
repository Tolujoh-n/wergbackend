const { ethers } = require('ethers');

/** Same rounding as frontend — matches on-chain uint256 wei. */
function payoutToWei(amount) {
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('Invalid payout amount');
  }
  return ethers.parseEther(n.toFixed(18));
}

function predictionIdToBytes32(predictionDocId) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(predictionDocId)));
}

module.exports = { payoutToWei, predictionIdToBytes32 };
