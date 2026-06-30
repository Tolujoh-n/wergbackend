const { ethers } = require('ethers');

/** Base mainnet defaults — override via env for testnet or other networks. */
const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_MAINNET_RPC_READ = 'https://mainnet.base.org';
const BASE_MAINNET_RPC_WRITE = 'https://base-mainnet.g.alchemy.com/v2/Hxf5ScqK60A4F79smz5VX';
const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Public Base RPC for read-only calls (balance checks, contract views). */
function getReadRpcUrl() {
  return (
    process.env.BASE_READ_RPC_URL ||
    process.env.BASE_RPC_READ_URL ||
    BASE_MAINNET_RPC_READ
  );
}

/** Private Alchemy (or dedicated) RPC for signed transactions (relayer, settlement bot). */
function getWriteRpcUrl() {
  return (
    process.env.BASE_WRITE_RPC_URL ||
    process.env.BASE_RPC_WRITE_URL ||
    process.env.BASE_RPC_URL ||
    BASE_MAINNET_RPC_WRITE
  );
}

/** @deprecated Prefer getReadRpcUrl / getWriteRpcUrl — kept for status endpoints. */
function getRpcUrl() {
  return getWriteRpcUrl();
}

function getRpcFallbackUrl() {
  return process.env.BASE_RPC_URL_FALLBACK || 'https://base-rpc.publicnode.com';
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

let cachedReadProvider = null;
let cachedReadProviderUrl = null;
let cachedWriteProvider = null;
let cachedWriteProviderUrl = null;
let cachedFallbackProvider = null;
let cachedFallbackProviderUrl = null;

function createCachedProvider(url, cacheRef) {
  const chainId = getChainId();
  if (cacheRef.provider && cacheRef.url === url) return cacheRef.provider;
  cacheRef.provider = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
  cacheRef.url = url;
  return cacheRef.provider;
}

const readCache = { provider: null, url: null };
const writeCache = { provider: null, url: null };
const fallbackCache = { provider: null, url: null };

/** Read-only JsonRpcProvider (public Base RPC + fallback). */
function getReadJsonRpcProvider() {
  return createCachedProvider(getReadRpcUrl(), readCache);
}

/** JsonRpcProvider for relayer / settlement bot signed transactions. */
function getWriteJsonRpcProvider() {
  return createCachedProvider(getWriteRpcUrl(), writeCache);
}

/** Fallback provider when primary RPC is rate-limited (read or write). */
function getJsonRpcProviderFallback() {
  const url = getRpcFallbackUrl();
  return createCachedProvider(url, fallbackCache);
}

/** @deprecated Use getReadJsonRpcProvider or getWriteJsonRpcProvider explicitly. */
function getJsonRpcProvider() {
  return getWriteJsonRpcProvider();
}

module.exports = {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_RPC_READ,
  BASE_MAINNET_RPC_WRITE,
  BASE_MAINNET_USDC,
  getReadRpcUrl,
  getWriteRpcUrl,
  getRpcUrl,
  getRpcFallbackUrl,
  getChainId,
  getUsdcAddress,
  getContractAddress,
  getBlockExplorerBase,
  getReadJsonRpcProvider,
  getWriteJsonRpcProvider,
  getJsonRpcProvider,
  getJsonRpcProviderFallback,
};
