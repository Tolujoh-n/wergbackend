const crypto = require('crypto');
const { ethers } = require('ethers');
const WalletChallenge = require('../models/WalletChallenge');

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function normalizeWalletAddress(addr) {
  if (!addr) return null;
  try {
    return ethers.getAddress(String(addr).trim()).toLowerCase();
  } catch {
    const s = String(addr).trim().toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(s) ? s : null;
  }
}

function buildOwnershipMessage({ address, purpose, nonce, expiresAt }) {
  const action =
    purpose === 'link'
      ? 'Link this wallet to your WeRgame account'
      : 'Sign in to WeRgame (login or create account)';
  return [
    'WeRgame wallet ownership proof',
    '',
    action,
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
    `Expires At: ${new Date(expiresAt).toISOString()}`,
    '',
    'This request will not trigger a blockchain transaction or cost gas.',
  ].join('\n');
}

async function createWalletChallenge({ address, purpose, userId = null }) {
  const addr = normalizeWalletAddress(address);
  if (!addr) {
    const err = new Error('Invalid wallet address');
    err.statusCode = 400;
    throw err;
  }
  const p = purpose === 'link' ? 'link' : 'auth';
  if (p === 'link' && !userId) {
    const err = new Error('Login required to link a wallet');
    err.statusCode = 401;
    throw err;
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  const checksum = ethers.getAddress(addr);
  const message = buildOwnershipMessage({
    address: checksum,
    purpose: p,
    nonce,
    expiresAt,
  });

  await WalletChallenge.create({
    address: addr,
    purpose: p,
    nonce,
    message,
    userId: userId || null,
    expiresAt,
    used: false,
  });

  return {
    address: checksum,
    purpose: p,
    nonce,
    message,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Verify signature against a one-time challenge and consume it.
 */
async function verifyAndConsumeWalletProof({
  address,
  purpose,
  signature,
  nonce,
  userId = null,
}) {
  const addr = normalizeWalletAddress(address);
  if (!addr) {
    const err = new Error('Invalid wallet address');
    err.statusCode = 400;
    throw err;
  }
  if (!signature || !nonce) {
    const err = new Error('signature and nonce are required to prove wallet ownership');
    err.statusCode = 400;
    err.code = 'WALLET_PROOF_REQUIRED';
    throw err;
  }

  const p = purpose === 'link' ? 'link' : 'auth';
  const query = {
    address: addr,
    purpose: p,
    nonce: String(nonce),
    used: false,
    expiresAt: { $gt: new Date() },
  };
  if (p === 'link' && userId) {
    query.userId = userId;
  }

  const challenge = await WalletChallenge.findOneAndUpdate(
    query,
    { $set: { used: true } },
    { new: true }
  );

  if (!challenge) {
    const err = new Error('Invalid or expired wallet signature challenge. Please try again.');
    err.statusCode = 401;
    err.code = 'WALLET_PROOF_INVALID';
    throw err;
  }

  let recovered;
  try {
    recovered = ethers.verifyMessage(challenge.message, signature);
  } catch {
    const err = new Error('Invalid wallet signature');
    err.statusCode = 401;
    err.code = 'WALLET_PROOF_INVALID';
    throw err;
  }

  if (normalizeWalletAddress(recovered) !== addr) {
    const err = new Error('Signature does not match this wallet address');
    err.statusCode = 401;
    err.code = 'WALLET_PROOF_MISMATCH';
    throw err;
  }

  return { address: addr, checksum: ethers.getAddress(addr) };
}

module.exports = {
  normalizeWalletAddress,
  createWalletChallenge,
  verifyAndConsumeWalletProof,
  CHALLENGE_TTL_MS,
};
