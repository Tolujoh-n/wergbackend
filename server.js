const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const cron = require('node-cron');

dotenv.config();

const { ethers } = require('ethers');
const { getClaimSignerAddress } = require('./utils/claimAuth');
const { router: ethPriceRouter, updateEthPrice } = require('./routes/ethPrice');
const { marketMakerMaintenanceOnce } = require('./services/marketMakerBot');
const {
  processSettlementOutboxBatch,
  releaseStaleProcessingJobs,
} = require('./services/settlementOutbox');
const { migrateOrderbookPositionLedger } = require('./utils/orderbookPositionLedger');
const { processAllDueGoldenTicketGrants } = require('./services/goldenTicketDailyGrantService');
const { corsOptions, applyCorsHeaders, isAllowedOrigin } = require('./utils/corsConfig');

const app = express();

app.set('trust proxy', 1);

app.use(applyCorsHeaders);
app.use(cors(corsOptions()));
app.use(applyCorsHeaders);
app.use(express.json());

// Lightweight health checks for uptime monitors / load balancers (no DB hit required).
const healthHandler = (req, res) => {
  const dbState = mongoose.connection.readyState; // 1 = connected
  res.json({
    ok: true,
    db: dbState === 1 ? 'connected' : 'disconnected',
    dbState,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/cups', require('./routes/cups'));
app.use('/api/matches', require('./routes/matches'));
app.use('/api/polls', require('./routes/polls'));
app.use('/api/predictions', require('./routes/predictions'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/superadmin', require('./routes/superadmin'));
app.use('/api/claims', require('./routes/claims'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/streaks', require('./routes/streaks'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/jackpots', require('./routes/jackpots'));
app.use('/api/tickets', require('./routes/tickets'));
app.use('/api/stages', require('./routes/stages'));
app.use('/api/blogs', require('./routes/blogs'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/newsletter', require('./routes/newsletter'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/eth-price', ethPriceRouter);
app.use('/api/relayer', require('./routes/relayer'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/orderbook', require('./routes/orderbook'));
app.use('/api/admin/orderbook', require('./routes/orderbookAdmin'));

app.use('/api/config', require('./routes/config'));

// Legacy alias
app.get('/api/config/claim', (req, res) => {
  const raw = process.env.CONTRACT_ADDRESS || process.env.REACT_APP_CONTRACT_ADDRESS;
  let contractAddress = null;
  try {
    contractAddress = raw ? ethers.getAddress(raw) : null;
  } catch {
    contractAddress = raw || null;
  }
  res.json({
    contractAddress,
    chainId: require('./utils/chainConfig').getChainId(),
    claimSignerAddress: getClaimSignerAddress(),
  });
});

// 404 for unknown API routes (keeps CORS headers from applyCorsHeaders above).
app.use('/api', (req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Global error handler — ensures a thrown route error returns JSON WITH CORS headers
// instead of bubbling to a generic 500 (which the browser would report as a CORS error).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin) && !res.headersSent) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  console.error('[express error]', req.method, req.originalUrl, '-', err?.message || err);
  if (res.headersSent) return;
  const status = err?.statusCode || err?.status || 500;
  res.status(status).json({ message: err?.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

// Keep the process alive on unexpected errors so the whole API never goes down
// from a single stray exception (e.g. a cron job hitting an RPC hiccup).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
});

async function connectWithRetry(attempt = 1) {
  try {
    await mongoose.connect(process.env.MONGODB_URI || '', {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 20,
    });
  } catch (err) {
    const delay = Math.min(30000, attempt * 3000);
    console.error(
      `MongoDB connection error (attempt ${attempt}):`,
      err?.message || err,
      `— retrying in ${delay / 1000}s`
    );
    setTimeout(() => connectWithRetry(attempt + 1), delay);
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('[mongo] disconnected — driver will attempt to reconnect');
});
mongoose.connection.on('reconnected', () => {
  console.log('[mongo] reconnected');
});

// One-time background jobs — scheduled only after the DB is first connected.
let backgroundJobsStarted = false;
async function startBackgroundJobs() {
  if (backgroundJobsStarted) return;
  backgroundJobsStarted = true;
  try {
    await migrateOrderbookPositionLedger();
  } catch (e) {
    console.warn('[orderbook] position ledger migration:', e.message || e);
  }
  updateEthPrice();
  cron.schedule('*/5 * * * *', async () => {
    try {
      await updateEthPrice();
    } catch (e) {
      console.error('updateEthPrice', e.message || e);
    }
  });
  cron.schedule('* * * * *', async () => {
    try {
      await marketMakerMaintenanceOnce();
    } catch (e) {
      console.error('marketMakerMaintenanceOnce', e.message);
    }
    try {
      await releaseStaleProcessingJobs(120000);
      await processSettlementOutboxBatch(10);
    } catch (e) {
      console.error('settlementOutbox maintenance', e.message || e);
    }
  });
  cron.schedule('5 * * * *', async () => {
    try {
      const r = await processAllDueGoldenTicketGrants();
      if (r.ticketsGranted > 0) {
        console.log(
          `goldenTicketDailyGrants: ${r.ticketsGranted} ticket(s) to ${r.usersTouched} user(s)`
        );
      }
    } catch (e) {
      console.error('goldenTicketDailyGrants', e.message);
    }
  });
}

mongoose.connection.once('connected', () => {
  console.log('MongoDB connected');
  startBackgroundJobs();
});

connectWithRetry();

// Start serving immediately. Routes that need the DB fail per-request (handled by the
// global error handler) instead of taking the whole server down while the DB connects.
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
