const express = require('express');
const { ethers } = require('ethers');
const { getContractAddress, getChainId, getJsonRpcProvider } = require('../utils/chainConfig');
const { getClaimSignerAddress } = require('../utils/claimAuth');
const { getWeRgameAbiSync } = require('../utils/wergameContractAbi');

const router = express.Router();

function checksumOrNull(raw) {
  if (!raw) return null;
  try {
    return ethers.getAddress(String(raw).trim());
  } catch {
    return null;
  }
}

/** Public chain + deployment addresses (frontend must match backend after redeploy). */
router.get('/blockchain', (req, res) => {
  const contractAddress = getContractAddress();
  const usdcAddress = checksumOrNull(process.env.USDC_ADDRESS || process.env.REACT_APP_USDC_ADDRESS);
  res.json({
    contractAddress,
    usdcAddress,
    chainId: getChainId(),
    claimSignerAddress: getClaimSignerAddress(),
    usdcDecimals: parseInt(process.env.USDC_DECIMALS || '6', 10),
  });
});

/** USDC balance + allowance for a wallet (server RPC — avoids browser SSL/RPC issues). */
router.get('/blockchain/usdc-state', async (req, res) => {
  try {
    const wallet = checksumOrNull(req.query.wallet);
    if (!wallet) return res.status(400).json({ ok: false, message: 'wallet query required' });
    const contractAddress = getContractAddress();
    const usdcAddress = checksumOrNull(process.env.USDC_ADDRESS || process.env.REACT_APP_USDC_ADDRESS);
    if (!contractAddress || !usdcAddress) {
      return res.status(503).json({ ok: false, message: 'CONTRACT_ADDRESS or USDC_ADDRESS not configured' });
    }
    const spender = checksumOrNull(req.query.spender) || contractAddress;
    const provider = getJsonRpcProvider();
    const erc = new ethers.Contract(
      usdcAddress,
      [
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address owner, address spender) view returns (uint256)',
      ],
      provider
    );
    const [balance, allowance] = await Promise.all([
      erc.balanceOf(wallet),
      erc.allowance(wallet, spender),
    ]);
    res.json({
      ok: true,
      wallet,
      spender,
      usdcAddress,
      contractAddress,
      balanceWei: balance.toString(),
      allowanceWei: allowance.toString(),
      balanceUsdc: ethers.formatUnits(balance, 6),
      allowanceUsdc: ethers.formatUnits(allowance, 6),
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message || 'USDC read failed' });
  }
});

/** Verify WeRgame + MockUSDC exist on configured RPC (debug after redeploy). */
router.get('/blockchain/verify', async (req, res) => {
  try {
    const contractAddress = getContractAddress();
    const usdcAddress = checksumOrNull(process.env.USDC_ADDRESS || process.env.REACT_APP_USDC_ADDRESS);
    if (!contractAddress || !usdcAddress) {
      return res.status(503).json({ ok: false, message: 'CONTRACT_ADDRESS or USDC_ADDRESS not configured' });
    }
    const provider = getJsonRpcProvider();
    const chainId = Number((await provider.getNetwork()).chainId);
    const wergCode = await provider.getCode(contractAddress);
    const usdcCode = await provider.getCode(usdcAddress);
    const c = new ethers.Contract(contractAddress, getWeRgameAbiSync(), provider);
    const onChainUsdc = await c.usdc();
    const usdcMatch = ethers.getAddress(onChainUsdc) === ethers.getAddress(usdcAddress);
    res.json({
      ok: wergCode !== '0x' && usdcCode !== '0x' && usdcMatch,
      chainId,
      contractAddress,
      usdcAddress,
      onChainUsdcFromWeRgame: onChainUsdc,
      usdcMatch,
      wergHasCode: wergCode !== '0x',
      usdcHasCode: usdcCode !== '0x',
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
