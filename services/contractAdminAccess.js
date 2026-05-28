const { ethers } = require('ethers');
const WalletLink = require('../models/WalletLink');
const { getContractAddress, getJsonRpcProvider } = require('../utils/chainConfig');
const { getWeRgameAbiSync } = require('../utils/wergameContractAbi');

const adminCache = new Map();
const CACHE_MS = 30_000;

function norm(addr) {
  const s = String(addr || '').trim();
  if (!s || !ethers.isAddress(s)) return null;
  return ethers.getAddress(s).toLowerCase();
}

async function isWalletOnChainAdmin(walletAddress) {
  const w = norm(walletAddress);
  if (!w) return false;

  const cached = adminCache.get(w);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.ok;

  const contractAddr = getContractAddress();
  if (!contractAddr) {
    adminCache.set(w, { ok: false, at: Date.now() });
    return false;
  }

  let ok = false;
  try {
    const provider = getJsonRpcProvider();
    const c = new ethers.Contract(contractAddr, getWeRgameAbiSync(), provider);
    ok = !!(await c.admins(ethers.getAddress(w)));
  } catch (e) {
    console.warn('contractAdminAccess: admins() read failed', e?.message || e);
    ok = false;
  }

  adminCache.set(w, { ok, at: Date.now() });
  return ok;
}

function dbRoleHasAdminAccess(role) {
  return role === 'admin' || role === 'superAdmin';
}

/**
 * True if user has DB admin/superAdmin role OR any linked wallet is on-chain admin.
 */
async function userHasAdminAccess(user) {
  if (!user) return false;
  if (dbRoleHasAdminAccess(user.role)) return true;

  const links = await WalletLink.find({ user: user._id }).select('walletAddress').lean();
  for (const link of links) {
    if (await isWalletOnChainAdmin(link.walletAddress)) return true;
  }
  return false;
}

/** Wallets linked to this user that are on-chain admins. */
async function contractAdminWalletsForUser(userId) {
  const links = await WalletLink.find({ user: userId }).select('walletAddress').lean();
  const out = [];
  for (const link of links) {
    const w = link.walletAddress;
    if (w && (await isWalletOnChainAdmin(w))) out.push(w);
  }
  return out;
}

function clearAdminCacheForWallet(walletAddress) {
  const w = norm(walletAddress);
  if (w) adminCache.delete(w);
}

module.exports = {
  isWalletOnChainAdmin,
  userHasAdminAccess,
  contractAdminWalletsForUser,
  clearAdminCacheForWallet,
  dbRoleHasAdminAccess,
};
