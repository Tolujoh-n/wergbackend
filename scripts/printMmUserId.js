/**
 * Print MongoDB _id for a user email (for MARKET_MAKER_USER_ID in backend/.env).
 * Usage: node scripts/printMmUserId.js [email]
 * Default email: admin@wergame.com
 */
require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');

const User = require(path.join(__dirname, '..', 'models', 'User'));

const email = (process.argv[2] || 'admin@wergame.com').trim().toLowerCase();

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set (backend/.env)');
    process.exit(1);
  }
  try {
    await mongoose.connect(uri);
    const u = await User.findOne({ email }).select('_id email username role').lean();
    if (!u) {
      console.error(`No user found with email: ${email}`);
      process.exit(1);
    }
    console.log('Set in backend/.env:');
    console.log(`MARKET_MAKER_USER_ID=${u._id.toString()}`);
    console.log('');
    console.log(JSON.stringify({ ...u, _id: u._id.toString() }, null, 2));
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();
