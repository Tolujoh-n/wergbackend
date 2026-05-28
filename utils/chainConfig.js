const { ethers } = require('ethers');

function getRpcUrl() {
  return process.env.BASE_RPC_URL || process.env.BASE_RPC || 'https://base-sepolia-rpc.publicnode.com';
}

function getChainId() {
  return parseInt(process.env.CHAIN_ID || '84532', 10);
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

/**
 * Single JsonRpcProvider for server-side reads/sends. Uses CHAIN_ID + staticNetwork
 * so ethers does not depend on a separate eth_chainId "network detect" round-trip
 * (avoids "JsonRpcProvider failed to detect network" on flaky or slow RPCs).
 */
function getJsonRpcProvider() {
  const url = getRpcUrl();
  const chainId = getChainId();
  return new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
}

module.exports = { getRpcUrl, getChainId, getContractAddress, getJsonRpcProvider };
