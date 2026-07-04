/**
 * Fetch jackpot in/out events for WeRgame contract on Base.
 * Usage: node scripts/fetchJackpotLedger.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const CONTRACT = '0x05A675706187aD3eCA82F1F56596eaCFaBFE4447';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const EXPECTED_DEPLOYER = '0x4891ffc5c06aafc722792021d6d1b3564ef44f87';
const DEPLOY_BLOCK = 47002945;
const RPC =
  process.env.BASE_READ_RPC_URL ||
  process.env.BASE_WRITE_RPC_URL ||
  process.env.BASE_RPC_URL;
if (!RPC) {
  console.error('Set BASE_READ_RPC_URL or BASE_WRITE_RPC_URL in backend/.env');
  process.exit(1);
}

const iface = new ethers.Interface([
  'event JackpotFunded(uint256 amount)',
  'event JackpotWithdrawn(address indexed user, uint256 amount)',
  'event JackpotPoolWithdrawn(address indexed to, uint256 amount)',
  'function jackpotPool() view returns (uint256)',
  'function claimAuthSigner() view returns (address)',
  'function deployer() view returns (address)',
  'function superAdmin() view returns (address)',
  'function claimPredictionWinsPool() view returns (uint256)',
  'function getTreasurySnapshot() view returns (uint256 usdcBalance, uint256 claimPoolBalance, uint256 jackpotPoolBalance, uint256 tradingVaultLiabilities, uint256 maxRoutineTransfer)',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getLogsChunked(provider, topic, fromBlock, toBlock) {
  const CHUNK = 9999;
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK + 1) {
    const end = Math.min(start + CHUNK, toBlock);
    let part = [];
    for (let t = 0; t < 5; t += 1) {
      try {
        part = await provider.getLogs({ address: CONTRACT, fromBlock: start, toBlock: end, topics: [topic] });
        break;
      } catch (e) {
        await sleep(600 * (t + 1));
        if (t === 4) throw e;
      }
    }
    out.push(...part);
    process.stderr.write(`  blocks ${start}-${end}: +${part.length}\n`);
    await sleep(120);
  }
  return out;
}

async function loadBlockTimes(provider, blockNumbers) {
  const unique = [...new Set(blockNumbers)];
  const map = new Map();
  const BATCH = 20;
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const blocks = await Promise.all(slice.map((n) => provider.getBlock(n)));
    for (const b of blocks) {
      if (b) map.set(b.number, b.timestamp);
    }
    if (i % 200 === 0) process.stderr.write(`  timestamps ${Math.min(i + BATCH, unique.length)}/${unique.length}\n`);
  }
  return map;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const contract = new ethers.Contract(CONTRACT, iface, provider);
  const usdc = new ethers.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
  const latest = await provider.getBlockNumber();

  const [jackpotPool, claimAuthSigner, deployer, superAdmin, claimPool, treasury, usdcBal] =
    await Promise.all([
      contract.jackpotPool(),
      contract.claimAuthSigner(),
      contract.deployer(),
      contract.superAdmin(),
      contract.claimPredictionWinsPool(),
      contract.getTreasurySnapshot(),
      usdc.balanceOf(CONTRACT),
    ]);

  const topics = {
    funded: ethers.id('JackpotFunded(uint256)'),
    withdrawn: ethers.id('JackpotWithdrawn(address,uint256)'),
    poolWithdrawn: ethers.id('JackpotPoolWithdrawn(address,uint256)'),
  };

  process.stderr.write('Fetching JackpotFunded...\n');
  const fundedLogs = await getLogsChunked(provider, topics.funded, DEPLOY_BLOCK, latest);
  process.stderr.write('Fetching JackpotWithdrawn...\n');
  const withdrawnLogs = await getLogsChunked(provider, topics.withdrawn, DEPLOY_BLOCK, latest);
  process.stderr.write('Fetching JackpotPoolWithdrawn...\n');
  const poolWdLogs = await getLogsChunked(provider, topics.poolWithdrawn, DEPLOY_BLOCK, latest);

  const allLogs = [...fundedLogs, ...withdrawnLogs, ...poolWdLogs];
  const blockTimes = await loadBlockTimes(
    provider,
    allLogs.map((l) => l.blockNumber)
  );

  const basescanTx = (hash) => `https://basescan.org/tx/${hash}`;
  const rows = [];

  for (const log of fundedLogs) {
    const p = iface.parseLog(log);
    rows.push({
      time: new Date(blockTimes.get(log.blockNumber) * 1000).toISOString(),
      block: log.blockNumber,
      txHash: log.transactionHash,
      basescan: basescanTx(log.transactionHash),
      direction: 'IN',
      type: 'JackpotFunded',
      amountUsdc: ethers.formatUnits(p.args.amount, 6),
      wallet: '',
      note: 'Deployer called fundJackpotPool()',
    });
  }

  for (const log of withdrawnLogs) {
    const p = iface.parseLog(log);
    const wallet = ethers.getAddress(p.args.user);
    rows.push({
      time: new Date(blockTimes.get(log.blockNumber) * 1000).toISOString(),
      block: log.blockNumber,
      txHash: log.transactionHash,
      basescan: basescanTx(log.transactionHash),
      direction: 'OUT',
      type: 'JackpotWithdrawn',
      amountUsdc: ethers.formatUnits(p.args.amount, 6),
      wallet,
      walletBasescan: `https://basescan.org/address/${wallet}`,
      note: 'User withdraw (withdrawJackpotWithAuth)',
    });
  }

  for (const log of poolWdLogs) {
    const p = iface.parseLog(log);
    const wallet = ethers.getAddress(p.args.to);
    rows.push({
      time: new Date(blockTimes.get(log.blockNumber) * 1000).toISOString(),
      block: log.blockNumber,
      txHash: log.transactionHash,
      basescan: basescanTx(log.transactionHash),
      direction: 'OUT',
      type: 'JackpotPoolWithdrawn',
      amountUsdc: ethers.formatUnits(p.args.amount, 6),
      wallet,
      walletBasescan: `https://basescan.org/address/${wallet}`,
      note: 'Deployer pulled from jackpot pool',
    });
  }

  rows.sort((a, b) => a.block - b.block);

  let totalIn = 0;
  let totalOut = 0;
  const byWallet = new Map();
  for (const r of rows) {
    const n = parseFloat(r.amountUsdc);
    if (r.direction === 'IN') totalIn += n;
    else {
      totalOut += n;
      if (r.wallet) {
        byWallet.set(r.wallet, (byWallet.get(r.wallet) || 0) + n);
      }
    }
  }

  const topWithdrawers = [...byWallet.entries()]
    .map(([wallet, totalUsdc]) => ({ wallet, totalUsdc: totalUsdc.toFixed(6) }))
    .sort((a, b) => parseFloat(b.totalUsdc) - parseFloat(a.totalUsdc))
    .slice(0, 20);

  const report = {
    generatedAt: new Date().toISOString(),
    contract: CONTRACT,
    basescan: `https://basescan.org/address/${CONTRACT}#events`,
    deployBlock: DEPLOY_BLOCK,
    latestBlock: latest,
    snapshot: {
      deployer,
      superAdmin,
      claimAuthSigner,
      deployerMatchesExpected: deployer.toLowerCase() === EXPECTED_DEPLOYER.toLowerCase(),
      claimAuthSignerIsDeployer: claimAuthSigner.toLowerCase() === deployer.toLowerCase(),
      jackpotPoolUsdc: ethers.formatUnits(jackpotPool, 6),
      claimPredictionWinsPoolUsdc: ethers.formatUnits(claimPool, 6),
      usdcBalanceUsdc: ethers.formatUnits(usdcBal, 6),
      treasury: {
        usdcBalance: ethers.formatUnits(treasury.usdcBalance, 6),
        claimPoolBalance: ethers.formatUnits(treasury.claimPoolBalance, 6),
        jackpotPoolBalance: ethers.formatUnits(treasury.jackpotPoolBalance, 6),
        tradingVaultLiabilities: ethers.formatUnits(treasury.tradingVaultLiabilities, 6),
        maxRoutineTransfer: ethers.formatUnits(treasury.maxRoutineTransfer, 6),
      },
    },
    summary: {
      jackpotFundedEvents: fundedLogs.length,
      jackpotWithdrawnEvents: withdrawnLogs.length,
      jackpotPoolWithdrawnEvents: poolWdLogs.length,
      totalInUsdc: totalIn.toFixed(6),
      totalOutUsdc: totalOut.toFixed(6),
      netFromEventsUsdc: (totalIn - totalOut).toFixed(6),
      currentJackpotPoolUsdc: ethers.formatUnits(jackpotPool, 6),
      topWithdrawers,
      note: 'Stake jackpot fees also add to jackpotPool silently (no JackpotFunded event).',
    },
    rows,
  };

  const outPath = path.join(__dirname, '..', 'jackpot-ledger-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  process.stderr.write(`Wrote ${outPath}\n`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
