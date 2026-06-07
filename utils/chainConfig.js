const { ethers } = require('ethers');

/** Base mainnet defaults — override via env for testnet or other networks. */
const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_MAINNET_RPC = 'https://mainnet.base.org';
const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function getRpcUrl() {
  return process.env.BASE_RPC_URL || process.env.BASE_RPC || BASE_MAINNET_RPC;
}

function getChainId() {
  return parseInt(process.env.CHAIN_ID || String(BASE_MAINNET_CHAIN_ID), 10);
}

function getUsdcAddress() {
  const raw = process.env.USDC_ADDRESS || process.env.REACT_APP_USDC_ADDRESS || BASE_MAINNET_USDC;
  try {
    return ethers.getAddress(String(raw).trim());
  } catch {
    return null;
  }
}

function getContractAddress() {
  const raw = process.env.CONTRACT_ADDRESS || process.env.REACT_APP_CONTRACT_ADDRESS;
  if (!raw) return null;
  try {
    return ethers.getAddress(String(raw).trim());
  } catch {
    return null;
  }
}

function getBlockExplorerBase() {
  const chainId = getChainId();
  if (chainId === 84532) return 'https://sepolia.basescan.org';
  return process.env.BLOCK_EXPLORER || 'https://basescan.org';
}

/**
 * Single JsonRpcProvider for server-side reads/sends. Uses CHAIN_ID + staticNetwork
 * so ethers does not depend on a separate eth_chainId "network detect" round-trip.
 */
function getJsonRpcProvider() {
  const url = getRpcUrl();
  const chainId = getChainId();
  return new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
}

module.exports = {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_RPC,
  BASE_MAINNET_USDC,
  getRpcUrl,
  getChainId,
  getUsdcAddress,
  getContractAddress,
  getBlockExplorerBase,
  getJsonRpcProvider,
};
