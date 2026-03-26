const { ethers } = require('ethers');

/**
 * Accepts hex private key with or without 0x (common in .env). Trims quotes/whitespace.
 */
function normalizePrivateKey(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith('0x') || s.startsWith('0X')) {
    s = '0x' + s.slice(2);
  } else if (/^[0-9a-fA-F]{64}$/.test(s)) {
    s = `0x${s}`;
  } else {
    return null;
  }
  if (!ethers.isHexString(s, 32)) {
    return null;
  }
  return s;
}

function getClaimSignerWallet() {
  const pk = normalizePrivateKey(process.env.CLAIM_AUTH_PRIVATE_KEY);
  if (!pk) {
    throw new Error(
      'CLAIM_AUTH_PRIVATE_KEY is missing or invalid (use 64 hex characters, optional 0x prefix)'
    );
  }
  return new ethers.Wallet(pk);
}

/** Public address for ops / debugging (no secret). */
function getClaimSignerAddress() {
  try {
    return getClaimSignerWallet().address;
  } catch {
    return null;
  }
}

async function signPredictionClaimPayload({
  userAddress,
  marketId,
  isBoost,
  amountWei,
  predictionId,
  deadlineSec,
  chainId,
  contractAddress,
}) {
  const wallet = getClaimSignerWallet();
  const messageHash = ethers.solidityPackedKeccak256(
    ['address', 'uint256', 'bool', 'uint256', 'bytes32', 'uint256', 'uint256', 'address'],
    [
      userAddress,
      BigInt(marketId),
      isBoost,
      BigInt(amountWei),
      predictionId,
      BigInt(deadlineSec),
      BigInt(chainId),
      contractAddress,
    ]
  );
  const signature = await wallet.signMessage(ethers.getBytes(messageHash));
  return { signature };
}

async function signJackpotWithdrawPayload({
  userAddress,
  amountWei,
  nonce,
  deadlineSec,
  chainId,
  contractAddress,
}) {
  const wallet = getClaimSignerWallet();
  const messageHash = ethers.solidityPackedKeccak256(
    ['address', 'uint256', 'bytes32', 'uint256', 'uint256', 'address'],
    [userAddress, BigInt(amountWei), nonce, BigInt(deadlineSec), BigInt(chainId), contractAddress]
  );
  const signature = await wallet.signMessage(ethers.getBytes(messageHash));
  return { signature };
}

module.exports = {
  getClaimSignerAddress,
  signPredictionClaimPayload,
  signJackpotWithdrawPayload,
};
