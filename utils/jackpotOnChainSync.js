const { ethers } = require('ethers');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const { getWeRgameAbiSync } = require('./wergameContractAbi');
const { getReadJsonRpcProvider, getContractAddress } = require('./chainConfig');
const { getSettlementWallet } = require('./settlementRelay');
const { payoutToWei } = require('./claimEligibility');

function toUsdcFloat(units) {
  return parseFloat(ethers.formatUnits(units, 6));
}

async function readJackpotBalanceOnChain(walletAddress) {
  const addr = getContractAddress();
  if (!addr || !walletAddress) return null;
  try {
    const provider = getReadJsonRpcProvider();
    const c = new ethers.Contract(addr, getWeRgameAbiSync(), provider);
    const raw = await c.jackpotBalances(ethers.getAddress(walletAddress));
    return toUsdcFloat(raw);
  } catch (e) {
    console.warn('readJackpotBalanceOnChain:', e?.message || e);
    return null;
  }
}

async function setJackpotBalanceOnChain(walletAddress, balanceUsdc) {
  const addr = getContractAddress();
  if (!addr) {
    const err = new Error('CONTRACT_ADDRESS not configured');
    err.statusCode = 503;
    throw err;
  }
  const wallet = getSettlementWallet();
  const c = new ethers.Contract(addr, getWeRgameAbiSync(), wallet);
  const amountWei = payoutToWei(Math.max(0, Number(balanceUsdc) || 0));
  const tx = await c.setJackpotBalance(ethers.getAddress(walletAddress), amountWei);
  const receipt = await tx.wait();
  return receipt.hash;
}

async function batchSetJackpotBalancesOnChain(entries) {
  const addr = getContractAddress();
  if (!addr || !entries?.length) return null;
  const wallet = getSettlementWallet();
  const c = new ethers.Contract(addr, getWeRgameAbiSync(), wallet);
  const users = entries.map((e) => ethers.getAddress(e.walletAddress));
  const amounts = entries.map((e) => payoutToWei(Math.max(0, Number(e.balanceUsdc) || 0)));
  try {
    const tx = await c.batchSetJackpotBalances(users, amounts);
    const receipt = await tx.wait();
    return receipt.hash;
  } catch (e) {
    if (!String(e?.message || '').includes('batchSetJackpotBalances')) {
      throw e;
    }
    let lastHash = null;
    for (const entry of entries) {
      lastHash = await setJackpotBalanceOnChain(entry.walletAddress, entry.balanceUsdc);
    }
    return lastHash;
  }
}

/**
 * After resolve: set each winner's on-chain jackpotBalances to their DB jackpotBalance.
 */
async function syncJackpotBalancesForUsers(userIds) {
  const unique = [...new Set((userIds || []).map((id) => String(id)).filter(Boolean))];
  if (!unique.length) return { synced: 0 };

  const users = await User.find({ _id: { $in: unique } }).select('jackpotBalance').lean();
  const links = await WalletLink.find({ user: { $in: unique } }).lean();
  const walletByUser = new Map(links.map((l) => [String(l.user), l.walletAddress]));

  const entries = [];
  for (const u of users) {
    const w = walletByUser.get(String(u._id));
    if (!w) continue;
    entries.push({
      walletAddress: w,
      balanceUsdc:
        Math.max(0, Number(u.jackpotBalance) || 0) +
        Math.max(0, Number(u.jackpotBalancePending) || 0),
    });
  }
  if (!entries.length) return { synced: 0 };

  const txHash = await batchSetJackpotBalancesOnChain(entries);
  return { synced: entries.length, txHash };
}

function deferJackpotOnChainSync(userIds) {
  if (!userIds?.length) return;
  const ids = [...userIds];
  setImmediate(() => {
    syncJackpotBalancesForUsers(ids)
      .then((r) => {
        if (r?.txHash) console.log('jackpot on-chain sync:', r);
      })
      .catch((e) => console.error('jackpot on-chain sync:', e?.message || e));
  });
}

module.exports = {
  readJackpotBalanceOnChain,
  setJackpotBalanceOnChain,
  batchSetJackpotBalancesOnChain,
  syncJackpotBalancesForUsers,
  deferJackpotOnChainSync,
};
