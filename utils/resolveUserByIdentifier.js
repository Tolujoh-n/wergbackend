const User = require('../models/User');
const WalletLink = require('../models/WalletLink');

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve user by email (case-insensitive) or linked wallet address.
 * @param {{ email?: string, walletAddress?: string, identifier?: string }}
 */
async function resolveUserByIdentifier({ email, walletAddress, identifier }) {
  let user = null;
  const raw = String(identifier || email || walletAddress || '').trim();
  if (!raw) return null;

  if (email || raw.includes('@')) {
    const em = String(email || raw).trim();
    const safe = escapeRegExp(em);
    user = await User.findOne({ email: new RegExp(`^${safe}$`, 'i') });
    if (user) return user;
  }

  const wallet = String(walletAddress || raw).trim().toLowerCase();
  if (/^0x[a-f0-9]{40}$/i.test(wallet)) {
    const link = await WalletLink.findOne({ walletAddress: wallet }).lean();
    if (link?.user) user = await User.findById(link.user);
    if (user) return user;
    user = await User.findOne({ walletAddress: wallet });
  }

  return user;
}

module.exports = { resolveUserByIdentifier };
