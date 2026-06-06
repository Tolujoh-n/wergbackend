const fs = require('fs');
const path = require('path');

/** Cached ABI array for WeRgame (production bundles `backend/abi/WeRgame.json`). */
let cachedAbi = null;

/**
 * Resolve ABI JSON path: env override, then bundled backend/abi, then local monorepo builds.
 */
function resolveArtifactPath() {
  const env = process.env.WERGAME_CONTRACT_ARTIFACT_PATH;
  if (env && fs.existsSync(env)) return env;

  const candidates = [
    path.join(__dirname, '..', 'abi', 'WeRgame.json'),
    path.join(__dirname, '..', '..', 'smart-contracts', 'build', 'contracts', 'WeRgame.json'),
    path.join(__dirname, '..', '..', 'smart-contract', 'build', 'contracts', 'WeRgame.json'),
    path.join(__dirname, '..', '..', 'frontend', 'src', 'abi', 'WeRgame.json'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @returns {import('ethers').InterfaceAbi}
 */
function getWeRgameAbiSync() {
  if (cachedAbi) return cachedAbi;

  const artifactPath = resolveArtifactPath();
  if (!artifactPath) {
    throw new Error(
      'WeRgame ABI not found. Include backend/abi/WeRgame.json in the deploy bundle, or set WERGAME_CONTRACT_ARTIFACT_PATH to a JSON file containing { "abi": [...] }.'
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to read WeRgame artifact at ${artifactPath}: ${e.message}`);
  }

  if (!parsed || !Array.isArray(parsed.abi)) {
    throw new Error(`WeRgame artifact at ${artifactPath} must contain an "abi" array`);
  }

  cachedAbi = parsed.abi;
  return cachedAbi;
}

module.exports = { getWeRgameAbiSync, resolveArtifactPath };
