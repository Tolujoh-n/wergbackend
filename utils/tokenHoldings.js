const { ethers } = require('ethers');

const ERC721_ABI = ['function balanceOf(address owner) view returns (uint256)'];
const ERC1155_ABI = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
const ERC20_ABI = ['function balanceOf(address account) view returns (uint256)'];

function normalizeTokenStandard(cfg) {
  const s = String(cfg?.tokenStandard || cfg?.tokenType || 'auto')
    .toLowerCase()
    .trim();
  if (['erc721', 'nft', '721'].includes(s)) return 'erc721';
  if (['erc1155', '1155', 'ft', 'sft'].includes(s)) return 'erc1155';
  if (['erc20', '20', 'fungible', 'token'].includes(s)) return 'erc20';
  return 'auto';
}

function tokenIdBigInt(cfg) {
  const raw = cfg?.tokenId;
  if (raw === undefined || raw === null || raw === '') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

async function erc721Balance(provider, contractAddress, owner) {
  const c = new ethers.Contract(contractAddress, ERC721_ABI, provider);
  const bal = await c.balanceOf(owner);
  return BigInt(bal || 0) > 0n;
}

async function erc1155Balance(provider, contractAddress, owner, tokenId) {
  const c = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
  const bal = await c.balanceOf(owner, tokenId);
  return BigInt(bal || 0) > 0n;
}

async function erc20Balance(provider, contractAddress, owner) {
  const c = new ethers.Contract(contractAddress, ERC20_ABI, provider);
  const bal = await c.balanceOf(owner);
  return BigInt(bal || 0) > 0n;
}

/**
 * Returns true if `owner` holds any amount of the configured token (NFT or FT).
 */
async function ownerHoldsToken(provider, contractAddress, owner, cfg = {}) {
  const addr = String(contractAddress || '').trim();
  if (!addr || !ethers.isAddress(addr)) return false;
  const checksummed = ethers.getAddress(owner);
  const standard = normalizeTokenStandard(cfg);
  const tokenId = tokenIdBigInt(cfg);

  if (standard === 'erc721') {
    try {
      return await erc721Balance(provider, addr, checksummed);
    } catch {
      return false;
    }
  }
  if (standard === 'erc1155') {
    try {
      return await erc1155Balance(provider, addr, checksummed, tokenId);
    } catch {
      return false;
    }
  }
  if (standard === 'erc20') {
    try {
      return await erc20Balance(provider, addr, checksummed);
    } catch {
      return false;
    }
  }

  // auto: try ERC-721, ERC-1155 (configured id + id 0), then ERC-20
  try {
    if (await erc721Balance(provider, addr, checksummed)) return true;
  } catch {
    /* not ERC-721 */
  }
  try {
    if (await erc1155Balance(provider, addr, checksummed, tokenId)) return true;
    if (tokenId !== 0n && (await erc1155Balance(provider, addr, checksummed, 0n))) return true;
  } catch {
    /* not ERC-1155 */
  }
  try {
    if (await erc20Balance(provider, addr, checksummed)) return true;
  } catch {
    /* not ERC-20 */
  }
  return false;
}

/**
 * @param {string[]} wallets - lowercase or checksummed addresses
 */
async function anyWalletHoldsToken(wallets, cfg, provider) {
  if (!wallets?.length || !provider) return false;
  const addr = String(cfg?.contractAddress || '').trim();
  if (!addr || !ethers.isAddress(addr)) return false;

  const checks = [];
  for (const w of wallets) {
    try {
      const owner = ethers.getAddress(String(w).trim());
      checks.push(ownerHoldsToken(provider, addr, owner, cfg));
    } catch {
      checks.push(Promise.resolve(false));
    }
  }
  if (!checks.length) return false;
  const results = await Promise.all(checks);
  return results.some(Boolean);
}

module.exports = {
  normalizeTokenStandard,
  ownerHoldsToken,
  anyWalletHoldsToken,
};
