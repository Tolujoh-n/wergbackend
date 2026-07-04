/**
 * Ban users by username, email, or wallet address.
 *
 * Usage:
 *   node scripts/banUsers.js AlgoRandu user@example.com 0xabc...
 *   node scripts/banUsers.js --file banned-users.txt
 *   node scripts/banUsers.js --dry-run AlgoRandu
 *   node scripts/banUsers.js --unban AlgoRandu
 *
 * Default applies bans immediately. Pass --dry-run to preview only.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { resolveUserForBan, banUserById, unbanUserById } = require('../services/userBanService');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const UNBAN = args.includes('--unban');
const FILE_FLAG_INDEX = args.indexOf('--file');
const filePath = FILE_FLAG_INDEX >= 0 ? args[FILE_FLAG_INDEX + 1] : null;

const identifiers = args.filter(
  (a) => !a.startsWith('--') && a !== filePath
);

if (filePath) {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .forEach((line) => identifiers.push(line));
}

if (identifiers.length === 0) {
  console.error('Usage: node scripts/banUsers.js [--dry-run] [--unban] [--file path.txt] <username|email|wallet> ...');
  process.exit(1);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Mode: ${UNBAN ? 'UNBAN' : 'BAN'}${DRY_RUN ? ' (dry-run)' : ''}`);
  console.log(`Processing ${identifiers.length} identifier(s)...\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const identifier of identifiers) {
    try {
      const user = await resolveUserForBan({ identifier });
      if (!user) {
        console.log(`✗ NOT FOUND: ${identifier}`);
        failed += 1;
        continue;
      }

      if (DRY_RUN) {
        console.log(`→ Would ${UNBAN ? 'unban' : 'ban'}: ${user.username} (${user._id}) [${identifier}]`);
        ok += 1;
        continue;
      }

      if (UNBAN) {
        await unbanUserById(user._id);
        console.log(`✓ Unbanned: ${user.username} (${user._id})`);
      } else {
        const result = await banUserById(user._id);
        if (result.alreadyBanned) {
          console.log(`• Already banned: ${user.username} (${user._id})`);
          skipped += 1;
        } else {
          console.log(`✓ Banned: ${user.username} (${user._id})`);
          ok += 1;
        }
        continue;
      }
      ok += 1;
    } catch (error) {
      console.log(`✗ ERROR [${identifier}]: ${error.message}`);
      failed += 1;
    }
  }

  console.log(`\nDone. Success: ${ok}, skipped: ${skipped}, failed: ${failed}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
