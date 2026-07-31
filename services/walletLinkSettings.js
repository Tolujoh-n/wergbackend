const Settings = require('../models/Settings');

const DEFAULT_MAX_LINKED_WALLETS = 3;
const HARD_MAX_LINKED_WALLETS = 10;

async function getMaxLinkedWallets() {
  const s = await Settings.findOne({ key: 'maxLinkedWallets' }).lean();
  const n = parseInt(s?.value, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_LINKED_WALLETS;
  return Math.min(HARD_MAX_LINKED_WALLETS, n);
}

async function setMaxLinkedWallets(raw) {
  const n = Math.min(
    HARD_MAX_LINKED_WALLETS,
    Math.max(1, parseInt(raw, 10) || DEFAULT_MAX_LINKED_WALLETS)
  );
  await Settings.findOneAndUpdate(
    { key: 'maxLinkedWallets' },
    {
      $set: {
        value: n,
        description: 'Maximum wallet addresses a user can link to one account',
        updatedAt: new Date(),
      },
      $setOnInsert: { key: 'maxLinkedWallets' },
    },
    { upsert: true, new: true }
  );
  return n;
}

module.exports = {
  DEFAULT_MAX_LINKED_WALLETS,
  HARD_MAX_LINKED_WALLETS,
  getMaxLinkedWallets,
  setMaxLinkedWallets,
};
