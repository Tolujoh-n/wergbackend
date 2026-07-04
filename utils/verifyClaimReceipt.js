const { ethers } = require('ethers');
const { getWeRgameAbiSync } = require('./wergameContractAbi');
const { getReadJsonRpcProvider, getContractAddress } = require('./chainConfig');
const { payoutToWei } = require('./claimEligibility');

const JACKPOT_WITHDRAW_TOPIC = ethers.id('JackpotWithdrawn(address,uint256)');
const PREDICTION_WINS_CLAIMED_TOPIC = ethers.id('PredictionWinsClaimed(uint256,address,uint256)');
const ORDERBOOK_CLAIMED_TOPIC = ethers.id('OrderbookPositionClaimed(uint256,address,string,uint256)');

function claimVerifyError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeTxHash(txHash) {
  const h = String(txHash || '').trim();
  if (!h) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
    throw claimVerifyError('Invalid transaction hash');
  }
  return h.toLowerCase();
}

async function getSuccessReceipt(txHash) {
  const hash = normalizeTxHash(txHash);
  if (!hash) throw claimVerifyError('txHash is required');
  const provider = getReadJsonRpcProvider();
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) {
    throw claimVerifyError('Transaction not found yet — wait for confirmation and retry', 404);
  }
  if (receipt.status !== 1) {
    throw claimVerifyError('Transaction failed on-chain');
  }
  const contractAddress = getContractAddress();
  if (!contractAddress) {
    throw claimVerifyError('CONTRACT_ADDRESS not configured', 503);
  }
  if (String(receipt.to || '').toLowerCase() !== String(contractAddress).toLowerCase()) {
    throw claimVerifyError('Transaction was not sent to the WeRgame contract');
  }
  return { receipt, contractAddress: ethers.getAddress(contractAddress), hash };
}

function parseLogs(receipt, contractAddress) {
  const iface = new ethers.Interface(getWeRgameAbiSync());
  const out = [];
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== contractAddress.toLowerCase()) continue;
    try {
      out.push(iface.parseLog(log));
    } catch {
      /* not our event */
    }
  }
  return out;
}

/**
 * Verify a jackpot withdraw receipt matches wallet + amount.
 */
async function verifyJackpotWithdrawReceipt({ txHash, walletAddress, amountUsdc }) {
  const { receipt, contractAddress, hash } = await getSuccessReceipt(txHash);
  const wallet = ethers.getAddress(walletAddress);
  const expectedWei = payoutToWei(amountUsdc);
  const parsed = parseLogs(receipt, contractAddress);
  const match = parsed.find(
    (p) =>
      p.name === 'JackpotWithdrawn' &&
      ethers.getAddress(p.args.user) === wallet &&
      p.args.amount === expectedWei
  );
  if (!match) {
    throw claimVerifyError(
      'Transaction does not contain a matching JackpotWithdrawn event for this wallet and amount'
    );
  }
  return {
    txHash: hash,
    wallet,
    amountUsdc: Number(amountUsdc),
    amountWei: expectedWei,
  };
}

/**
 * Verify boost / AMM market claim receipt.
 */
async function verifyPredictionWinsClaimReceipt({
  txHash,
  walletAddress,
  marketId,
  amountUsdc,
}) {
  const { receipt, contractAddress, hash } = await getSuccessReceipt(txHash);
  const wallet = ethers.getAddress(walletAddress);
  const expectedWei = payoutToWei(amountUsdc);
  const mid = BigInt(marketId);
  const parsed = parseLogs(receipt, contractAddress);
  const match = parsed.find(
    (p) =>
      p.name === 'PredictionWinsClaimed' &&
      BigInt(p.args.marketId) === mid &&
      ethers.getAddress(p.args.user) === wallet &&
      p.args.amount === expectedWei
  );
  if (!match) {
    throw claimVerifyError(
      'Transaction does not contain a matching PredictionWinsClaimed event for this wallet and amount'
    );
  }
  return { txHash: hash, wallet, marketId: String(marketId), amountUsdc: Number(amountUsdc) };
}

/**
 * Verify orderbook position claim receipt.
 */
async function verifyOrderbookClaimReceipt({
  txHash,
  walletAddress,
  marketId,
  amountUsdc,
  positionKey,
}) {
  const { receipt, contractAddress, hash } = await getSuccessReceipt(txHash);
  const wallet = ethers.getAddress(walletAddress);
  const expectedWei = payoutToWei(amountUsdc);
  const mid = BigInt(marketId);
  const parsed = parseLogs(receipt, contractAddress);
  const match = parsed.find(
    (p) =>
      p.name === 'OrderbookPositionClaimed' &&
      BigInt(p.args.marketId) === mid &&
      ethers.getAddress(p.args.user) === wallet &&
      String(p.args.positionKey) === String(positionKey) &&
      p.args.amount === expectedWei
  );
  if (!match) {
    throw claimVerifyError(
      'Transaction does not contain a matching OrderbookPositionClaimed event for this wallet and amount'
    );
  }
  return { txHash: hash, wallet, marketId: String(marketId), amountUsdc: Number(amountUsdc) };
}

/**
 * Scan recent blocks for JackpotWithdrawn events for a wallet (stale-reservation recovery).
 */
async function findRecentJackpotWithdrawals(walletAddress, lookbackBlocks = 1500) {
  const contractAddress = getContractAddress();
  if (!contractAddress || !walletAddress) return [];

  const provider = getReadJsonRpcProvider();
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - lookbackBlocks);
  const walletTopic = ethers.zeroPadValue(ethers.getAddress(walletAddress), 32);

  let logs = [];
  const CHUNK = 9999;
  for (let start = fromBlock; start <= latest; start += CHUNK + 1) {
    const end = Math.min(start + CHUNK, latest);
    try {
      const part = await provider.getLogs({
        address: contractAddress,
        fromBlock: start,
        toBlock: end,
        topics: [JACKPOT_WITHDRAW_TOPIC, walletTopic],
      });
      logs = logs.concat(part);
    } catch (e) {
      console.warn('findRecentJackpotWithdrawals:', e?.message || e);
    }
  }

  const iface = new ethers.Interface(['event JackpotWithdrawn(address indexed user, uint256 amount)']);
  return logs.map((log) => {
    const p = iface.parseLog(log);
    return {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      amountUsdc: parseFloat(ethers.formatUnits(p.args.amount, 6)),
      amountWei: p.args.amount,
    };
  });
}

module.exports = {
  verifyJackpotWithdrawReceipt,
  verifyPredictionWinsClaimReceipt,
  verifyOrderbookClaimReceipt,
  findRecentJackpotWithdrawals,
  claimVerifyError,
};
