const { ethers } = require('ethers');
const WalletLink = require('../models/WalletLink');
const User = require('../models/User');
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

/** All wallet addresses associated with a user (WalletLink + legacy field). */
async function getWalletAddressesForUser(user) {
  const seen = new Set();
  const out = [];
  const links = await WalletLink.find({ user: user._id }).select('walletAddress').lean();
  for (const link of links) {
    const w = norm(link.walletAddress);
    if (w && !seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  const legacy = norm(user.walletAddress);
  if (legacy && !seen.has(legacy)) out.push(legacy);
  return out;
}

/**
 * True if user has DB admin/superAdmin role OR any linked wallet is on-chain admin.
 */
async function userHasAdminAccess(user) {
  if (!user) return false;
  if (dbRoleHasAdminAccess(user.role)) return true;

  const contractAddr = getContractAddress();
  if (!contractAddr) {
    console.warn('contractAdminAccess: CONTRACT_ADDRESS not set — on-chain admin check skipped');
    return false;
  }

  const wallets = await getWalletAddressesForUser(user);
  for (const w of wallets) {
    if (await isWalletOnChainAdmin(w)) return true;
  }
  return false;
}

/** Wallets linked to this user that are on-chain admins. */
async function contractAdminWalletsForUser(userId) {
  const u = await User.findById(userId).select('walletAddress').lean();
  const user = { _id: userId, walletAddress: u?.walletAddress || null };

  const out = [];
  const wallets = await getWalletAddressesForUser(user);
  for (const w of wallets) {
    if (await isWalletOnChainAdmin(w)) out.push(w);
  }
  return out;
}

function clearAdminCacheForWallet(walletAddress) {
  const w = norm(walletAddress);
  if (w) adminCache.delete(w);
}

module.exports = {
  isWalletOnChainAdmin,
  getWalletAddressesForUser,
  userHasAdminAccess,
  contractAdminWalletsForUser,
  clearAdminCacheForWallet,
  dbRoleHasAdminAccess,
};
