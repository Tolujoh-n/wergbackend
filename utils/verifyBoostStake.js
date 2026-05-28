const { ethers } = require('ethers');
const { getWeRgameAbiSync } = require('./wergameContractAbi');
const { getContractAddress, getJsonRpcProvider } = require('./chainConfig');

const USDC_DECIMALS = parseInt(process.env.USDC_DECIMALS || '6', 10);

function iface() {
  return new ethers.Interface(getWeRgameAbiSync());
}

/**
 * Verify a boost stake/add tx credited the claim pool on-chain (BoostStaked / BoostStakeAdded).
 * @returns {{ ok: true, netStakeUsdc: number, grossAmountUsdc: number } | { ok: false, reason: string }}
 */
async function verifyBoostStakeTx({ txHash, marketId, walletAddress, outcome }) {
  const contractAddr = getContractAddress();
  if (!contractAddr) return { ok: false, reason: 'CONTRACT_ADDRESS not configured' };
  if (!txHash || !marketId || !walletAddress) return { ok: false, reason: 'Missing tx or market or wallet' };

  let wallet;
  try {
    wallet = ethers.getAddress(String(walletAddress).trim());
  } catch {
    return { ok: false, reason: 'Invalid wallet address' };
  }

  const provider = getJsonRpcProvider();
  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(String(txHash).trim());
  } catch (e) {
    return { ok: false, reason: e.message || 'Failed to load receipt' };
  }
  if (!receipt || receipt.status !== 1) {
    return { ok: false, reason: 'Transaction not found or failed' };
  }
  if (String(receipt.to || '').toLowerCase() !== String(contractAddr).toLowerCase()) {
    return { ok: false, reason: 'Transaction was not sent to the WeRgame contract' };
  }

  const i = iface();
  const mid = BigInt(marketId);
  const outcomeNorm = String(outcome || '').trim();
  let netStakeWei = 0n;
  let matched = false;

  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== String(contractAddr).toLowerCase()) continue;
    let parsed;
    try {
      parsed = i.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.name !== 'BoostStaked' && parsed.name !== 'BoostStakeAdded') continue;
    const logMarketId = parsed.args.marketId ?? parsed.args[0];
    const logUser = parsed.args.user ?? parsed.args[1];
    const logOutcome = parsed.args.outcome ?? parsed.args[2];
    const logNet = parsed.args.amount ?? parsed.args[3];
    if (BigInt(logMarketId) !== mid) continue;
    if (String(logUser).toLowerCase() !== wallet.toLowerCase()) continue;
    if (String(logOutcome).trim() !== outcomeNorm) continue;
    netStakeWei += BigInt(logNet);
    matched = true;
  }

  if (!matched) {
    return { ok: false, reason: 'No BoostStaked/BoostStakeAdded event for this market, wallet, and outcome' };
  }

  const netStakeUsdc = parseFloat(ethers.formatUnits(netStakeWei, USDC_DECIMALS));
  return { ok: true, netStakeUsdc, grossAmountUsdc: null };
}

/**
 * Verify boost stake withdraw (BoostStakeWithdrawn).
 */
async function verifyBoostWithdrawTx({ txHash, marketId, walletAddress }) {
  const contractAddr = getContractAddress();
  if (!contractAddr) return { ok: false, reason: 'CONTRACT_ADDRESS not configured' };
  if (!txHash || !marketId || !walletAddress) return { ok: false, reason: 'Missing tx or market or wallet' };

  let wallet;
  try {
    wallet = ethers.getAddress(String(walletAddress).trim());
  } catch {
    return { ok: false, reason: 'Invalid wallet address' };
  }

  const provider = getJsonRpcProvider();
  const receipt = await provider.getTransactionReceipt(String(txHash).trim());
  if (!receipt || receipt.status !== 1) {
    return { ok: false, reason: 'Transaction not found or failed' };
  }

  const i = iface();
  const mid = BigInt(marketId);
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== String(contractAddr).toLowerCase()) continue;
    let parsed;
    try {
      parsed = i.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name !== 'BoostStakeWithdrawn') continue;
    const logMarketId = parsed.args.marketId ?? parsed.args[0];
    const logUser = parsed.args.user ?? parsed.args[1];
    if (BigInt(logMarketId) === mid && String(logUser).toLowerCase() === wallet.toLowerCase()) {
      return { ok: true };
    }
  }
  return { ok: false, reason: 'No BoostStakeWithdrawn event for this market and wallet' };
}

module.exports = { verifyBoostStakeTx, verifyBoostWithdrawTx };
