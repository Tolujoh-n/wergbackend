const { ethers } = require('ethers');
const Order = require('../models/Order');
const OrderbookPosition = require('../models/OrderbookPosition');
const SettlementOutbox = require('../models/SettlementOutbox');
const { withOrderbookContract, withOrderbookContractOrLegacy, orderbookContractAddressLower } = require('../utils/orderbookContractScope');
const { invalidateResolvedMarketCache } = require('../utils/resolvedMarkets');
const { readVaultBalance } = require('./orderbookService');
const { applyLegsToOrderbookPositions } = require('./settlementOutbox');
const { finalizeResolvedMarketSettlementsOnChain } = require('../utils/settlementRelay');
const { getContractAddress, getJsonRpcProvider } = require('../utils/chainConfig');
const { getWeRgameAbiSync } = require('../utils/wergameContractAbi');

const USDC_DECIMALS = parseInt(process.env.USDC_DECIMALS || '6', 10);

function toUnits(amountFloat) {
  const n = typeof amountFloat === 'number' ? amountFloat : parseFloat(amountFloat);
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) return 0n;
  return ethers.parseUnits(n.toFixed(USDC_DECIMALS), USDC_DECIMALS);
}

async function isMarketResolvedOnChain(chainMarketId) {
  const addr = getContractAddress();
  if (!addr) return false;
  try {
    const provider = getJsonRpcProvider();
    const c = new ethers.Contract(addr, getWeRgameAbiSync(), provider);
    const market = await c.markets(BigInt(chainMarketId));
    return !!(market.resolved ?? market[5]);
  } catch {
    return false;
  }
}

async function cancelOpenOrdersForMarket(chainMarketId) {
  await Order.updateMany(
    withOrderbookContractOrLegacy({
      chainMarketId,
      status: { $in: ['open', 'partially_filled', 'pending'] },
    }),
    { $set: { status: 'cancelled', reservedCollateral: 0, sizeRemaining: 0 } }
  );
}

async function cancelPendingSettlementsForMarket(chainMarketId) {
  await SettlementOutbox.updateMany(
    withOrderbookContractOrLegacy({
      chainMarketId,
      status: { $in: ['pending', 'processing'] },
    }),
    {
      $set: {
        status: 'cancelled',
        cancelReason: 'market_resolved',
        processingStartedAt: null,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Sweep any USDC still in user trading vaults for this market into claimPredictionWinsPool
 * and zero on-chain + off-chain positions.
 */
async function sweepVaultCollateralForResolvedMarket(chainMarketId) {
  const contractLower = orderbookContractAddressLower();
  if (!contractLower) {
    console.warn('orderbook finalize: CONTRACT_ADDRESS not set, skipping on-chain sweep');
    return { sweptUsdc: 0, txHash: null };
  }

  const onChainResolved = await isMarketResolvedOnChain(chainMarketId);
  if (!onChainResolved) {
    console.warn(
      `orderbook finalize: market ${chainMarketId} not resolved on-chain yet; cancelled orders/outbox only`
    );
    return { sweptUsdc: 0, txHash: null, skippedOnChain: true };
  }

  const positions = await OrderbookPosition.find(
    withOrderbookContractOrLegacy({
      chainMarketId,
      $or: [{ shares: { $gt: 1e-9 } }, { totalInvested: { $gt: 1e-9 } }],
    })
  ).lean();

  if (!positions.length) return { sweptUsdc: 0, txHash: null };

  const legs = [];
  let collateralToClaimPool = 0n;
  const vaultCache = new Map();

  for (const pos of positions) {
    const wallet = String(pos.walletAddress || '').toLowerCase();
    if (!wallet) continue;
    const shares = Number(pos.shares) || 0;
    const invested = Number(pos.totalInvested) || 0;
    if (shares <= 1e-9 && invested <= 1e-9) continue;

    let vaultBal = vaultCache.get(wallet);
    if (vaultBal == null) {
      vaultBal = await readVaultBalance(wallet);
      vaultCache.set(wallet, vaultBal);
    }
    const sweep = Math.min(Math.max(0, invested), Math.max(0, vaultBal));
    const sweepUnits = toUnits(sweep);
    const sharesUnits = toUnits(shares);
    const investedUnits = toUnits(invested);

    if (sweepUnits === 0n && sharesUnits === 0n && investedUnits === 0n) continue;

    legs.push({
      user: ethers.getAddress(wallet),
      positionKey: pos.positionKey,
      vaultDelta: (-sweepUnits).toString(),
      sharesDelta: (-sharesUnits).toString(),
      investedDelta: (-investedUnits).toString(),
    });
    collateralToClaimPool += sweepUnits;
  }

  if (!legs.length) {
    await OrderbookPosition.deleteMany(withOrderbookContract({ chainMarketId }));
    return { sweptUsdc: 0, txHash: null };
  }

  const txHash = await finalizeResolvedMarketSettlementsOnChain(
    chainMarketId,
    legs,
    collateralToClaimPool.toString()
  );

  await applyLegsToOrderbookPositions(chainMarketId, legs, contractLower);
  await OrderbookPosition.deleteMany(withOrderbookContract({ chainMarketId }));

  const sweptUsdc = parseFloat(ethers.formatUnits(collateralToClaimPool, USDC_DECIMALS));
  return { sweptUsdc, txHash, legCount: legs.length };
}

/**
 * Run after admin resolves a match/poll: release reserves, cancel stale settlement jobs,
 * sweep per-market vault exposure into the claim pool.
 * @param {{ marketId?: number }} item
 */
async function finalizeOrderbookMarketOnResolve(item) {
  const chainMarketId = item?.marketId;
  if (chainMarketId == null || !Number.isFinite(Number(chainMarketId))) {
    return { ok: false, reason: 'no_chain_market' };
  }
  const mid = Number(chainMarketId);

  invalidateResolvedMarketCache();

  await cancelOpenOrdersForMarket(mid);
  await cancelPendingSettlementsForMarket(mid);

  let sweep = { sweptUsdc: 0, txHash: null };
  try {
    sweep = await sweepVaultCollateralForResolvedMarket(mid);
  } catch (e) {
    console.error('orderbook finalize sweep:', e.message || e);
    return { ok: false, chainMarketId: mid, error: e.message || String(e) };
  }

  await OrderbookPosition.deleteMany(withOrderbookContract({ chainMarketId: mid }));

  return { ok: true, chainMarketId: mid, ...sweep };
}

module.exports = {
  finalizeOrderbookMarketOnResolve,
  cancelOpenOrdersForMarket,
  cancelPendingSettlementsForMarket,
};
