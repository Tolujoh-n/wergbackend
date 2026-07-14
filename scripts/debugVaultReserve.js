/**
 * Diagnose why vault reserved / open-buy count may be 0.
 * Usage: node scripts/debugVaultReserve.js [walletAddress]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { ethers } = require('ethers');

async function main() {
  const walletArg = process.argv[2] ? String(process.argv[2]).trim().toLowerCase() : null;
  await mongoose.connect(process.env.MONGODB_URI);
  const Order = require('../models/Order');
  const OrderbookPosition = require('../models/OrderbookPosition');
  const SettlementOutbox = require('../models/SettlementOutbox');
  const { orderbookContractAddressLower } = require('../utils/orderbookContractScope');
  const {
    openBuyOrderReservedUsd,
    pendingVaultDebitForWallet,
    reservedCollateralForWallet,
  } = require('../services/orderbookService');

  const c = orderbookContractAddressLower();
  console.log('CONTRACT_ADDRESS lower:', c);
  console.log('env CONTRACT_ADDRESS:', process.env.CONTRACT_ADDRESS);

  const openFilter = {
    status: { $in: ['pending', 'open', 'partially_filled'] },
    sizeRemaining: { $gt: 1e-9 },
  };

  const totals = {
    allOpen: await Order.countDocuments(openFilter),
    openBuys: await Order.countDocuments({ ...openFilter, direction: 'buy' }),
    openSells: await Order.countDocuments({ ...openFilter, direction: 'sell' }),
  };
  console.log('Global open totals:', totals);

  const wallets = await Order.aggregate([
    { $match: openFilter },
    {
      $group: {
        _id: { w: '$walletAddress', d: '$direction' },
        count: { $sum: 1 },
        notional: { $sum: { $multiply: ['$sizeRemaining', '$limitPrice'] } },
        reservedSum: { $sum: '$reservedCollateral' },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 30 },
  ]);
  console.log('Open by wallet/direction (top):', JSON.stringify(wallets, null, 2));

  const sample = await Order.find(openFilter)
    .sort({ updatedAt: -1 })
    .limit(12)
    .select(
      'walletAddress direction status sizeRemaining limitPrice reservedCollateral contractAddress orderKind updatedAt'
    )
    .lean();
  console.log('Recent open sample:', JSON.stringify(sample, null, 2));

  const distinctContracts = await Order.distinct('contractAddress', openFilter);
  console.log('Distinct contractAddress on open orders:', distinctContracts);

  if (walletArg) {
    let checksum;
    try {
      checksum = ethers.getAddress(walletArg);
    } catch {
      checksum = walletArg;
    }
    const wl = String(checksum).toLowerCase();
    console.log('\n--- Wallet', wl, '---');

    const rawBuys = await Order.find({ ...openFilter, direction: 'buy', walletAddress: wl })
      .select('contractAddress status sizeRemaining limitPrice reservedCollateral orderKind chainMarketId')
      .lean();
    const rawSells = await Order.find({ ...openFilter, direction: 'sell', walletAddress: wl })
      .select('contractAddress status sizeRemaining limitPrice orderKind')
      .lean();
    console.log('Raw buys (any contract):', rawBuys.length, rawBuys);
    console.log('Raw sells (any contract):', rawSells.length, rawSells);

    const positions = await OrderbookPosition.find({ walletAddress: wl, shares: { $gt: 1e-9 } })
      .select('positionKey shares totalInvested contractAddress chainMarketId')
      .lean();
    console.log('Positions:', positions);

    const [ob, pend, total] = await Promise.all([
      openBuyOrderReservedUsd(wl),
      pendingVaultDebitForWallet(wl),
      reservedCollateralForWallet(wl),
    ]);
    console.log('Computed reserved:', { openBuys: ob, pendingSettle: pend, total });

    const outbox = await SettlementOutbox.find({
      status: { $in: ['pending', 'processing', 'dead'] },
    })
      .select('status contractAddress chainMarketId legs')
      .limit(20)
      .lean();
    const related = outbox.filter((j) =>
      (j.legs || []).some((l) => String(l.user || '').toLowerCase() === wl)
    );
    console.log('Pending/dead outbox touching wallet:', related.length, related.slice(0, 5));
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
