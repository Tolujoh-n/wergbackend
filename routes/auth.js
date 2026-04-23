const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const WalletLink = require('../models/WalletLink');
const { auth } = require('../middleware/auth');
const { getSendgridConfigured, getSendgridFromEmail } = require('../utils/sendgrid');
const { generateNumericCode, hashResetCode, buildPasswordResetEmail } = require('../utils/passwordReset');

const router = express.Router();

const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: '7d',
  });
};

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findUserByEmailCaseInsensitive(email) {
  if (!email) return null;
  const safe = escapeRegExp(email.trim());
  const regex = new RegExp(`^${safe}$`, 'i');
  return await User.findOne({ email: regex });
}

function normalizeWalletAddress(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (!s) return null;
  return s.toLowerCase();
}

async function getUserWallets(userId) {
  const links = await WalletLink.find({ user: userId }).select('walletAddress').lean();
  return (links || []).map((l) => l.walletAddress).filter(Boolean);
}

async function toUserResponse(user) {
  if (!user) return null;
  const wallets = await getUserWallets(user._id);
  return {
    _id: user._id,
    id: user._id,
    username: user.username,
    email: user.email,
    role: user.role,
    walletAddress: user.walletAddress, // legacy field (may be null)
    wallets,
  };
}

async function ensureLegacyWalletLink(user) {
  const legacy = normalizeWalletAddress(user?.walletAddress);
  if (!legacy) return;
  const existing = await WalletLink.findOne({ walletAddress: legacy }).lean();
  if (existing) return;
  await WalletLink.create({ walletAddress: legacy, user: user._id });
}

async function linkWalletToUser({ userId, address }) {
  const walletAddress = normalizeWalletAddress(address);
  if (!walletAddress) {
    const err = new Error('walletAddress is required');
    err.statusCode = 400;
    throw err;
  }

  const existing = await WalletLink.findOne({ walletAddress }).lean();
  if (existing && String(existing.user) !== String(userId)) {
    const err = new Error('WALLET_IN_USE');
    err.statusCode = 409;
    err.ownerUserId = existing.user;
    throw err;
  }
  if (!existing) {
    await WalletLink.create({ walletAddress, user: userId });
  }

  // Best-effort: if legacy field is empty, set it to first linked wallet for compatibility.
  const u = await User.findById(userId).select('walletAddress').lean();
  if (!u?.walletAddress) {
    await User.findByIdAndUpdate(userId, { walletAddress }, { new: false });
  }
  return walletAddress;
}

// Signup with email/password
router.post('/signup', async (req, res) => {
  try {
    const { email, password, username } = req.body;

    const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
    const normalizedUsername = username ? String(username).trim() : '';

    if (!normalizedEmail || !normalizedUsername || !password) {
      return res.status(400).json({ message: 'Email, username, and password are required' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const emailExists = await User.findOne({ email: normalizedEmail });
    if (emailExists) {
      return res.status(400).json({ message: 'This email is already registered. Please login instead.' });
    }

    const usernameExists = await User.findOne({ username: normalizedUsername });
    if (usernameExists) {
      return res.status(400).json({ message: 'This username is already taken. Please choose another one.' });
    }

    const user = new User({ email: normalizedEmail, password, username: normalizedUsername });
    await user.save();

    const token = generateToken(user._id);
    res.json({ token, user: await toUserResponse(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Login with email OR username + password
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    const identifier = (req.body.identifier || req.body.email || '').trim();

    if (!identifier || !password) {
      return res.status(400).json({ message: 'Email/username and password are required' });
    }

    const userByEmail = await findUserByEmailCaseInsensitive(identifier);
    const user =
      userByEmail ||
      (await User.findOne({ username: identifier }));

    if (!user) {
      return res.status(404).json({ message: 'Account not found. Please check your email/username or sign up.' });
    }

    if (!user.password) {
      return res.status(400).json({ message: 'This account uses wallet login. Please connect your wallet to login.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Incorrect password. Please try again.' });
    }

    const token = generateToken(user._id);
    await ensureLegacyWalletLink(user);
    res.json({ token, user: await toUserResponse(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Request password reset code (email)
router.post('/password-reset/request', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const user = await findUserByEmailCaseInsensitive(email);
    if (user && user.email) {
      const code = generateNumericCode();
      const minutesValid = parseInt(process.env.PASSWORD_RESET_CODE_TTL_MINUTES || '10', 10);

      user.passwordReset = {
        codeHash: hashResetCode(code),
        expiresAt: new Date(Date.now() + minutesValid * 60 * 1000),
        sentAt: new Date(),
        attempts: 0,
      };
      await user.save();

      const sg = getSendgridConfigured();
      const from = getSendgridFromEmail();
      const appName = process.env.APP_NAME || 'WeRgame';
      const emailBody = buildPasswordResetEmail({ appName, code, minutesValid });

      await sg.send({
        to: user.email,
        from,
        subject: emailBody.subject,
        text: emailBody.text,
        html: emailBody.html,
      });
    }

    // Always return success to avoid account enumeration
    return res.json({ message: 'If that email exists, we sent a verification code.' });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to send reset email. Please try again later.' });
  }
});

// Verify password reset code (email + code)
router.post('/password-reset/verify', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    const code = (req.body.code || '').trim();
    if (!email || !code) {
      return res.status(400).json({ message: 'Email and code are required' });
    }

    const user = await findUserByEmailCaseInsensitive(email);
    if (!user || !user.passwordReset?.codeHash || !user.passwordReset?.expiresAt) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    if (user.passwordReset.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    const maxAttempts = parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS || '5', 10);
    if ((user.passwordReset.attempts || 0) >= maxAttempts) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    const ok = user.passwordReset.codeHash === hashResetCode(code);
    if (!ok) {
      user.passwordReset.attempts = (user.passwordReset.attempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    return res.json({ verified: true });
  } catch (error) {
    return res.status(500).json({ message: 'Verification failed' });
  }
});

// Confirm password reset (email + code + newPassword)
router.post('/password-reset/confirm', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    const code = (req.body.code || '').trim();
    const newPassword = req.body.newPassword || '';

    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Email, code, and new password are required' });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const user = await findUserByEmailCaseInsensitive(email);
    if (!user || !user.passwordReset?.codeHash || !user.passwordReset?.expiresAt) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    if (user.passwordReset.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    const maxAttempts = parseInt(process.env.PASSWORD_RESET_MAX_ATTEMPTS || '5', 10);
    if ((user.passwordReset.attempts || 0) >= maxAttempts) {
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    const ok = user.passwordReset.codeHash === hashResetCode(code);
    if (!ok) {
      user.passwordReset.attempts = (user.passwordReset.attempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: 'Invalid or expired code' });
    }

    user.password = newPassword;
    user.passwordReset = { codeHash: null, expiresAt: null, sentAt: null, attempts: 0 };
    await user.save();

    return res.json({ message: 'Password updated successfully' });
  } catch (error) {
    return res.status(500).json({ message: 'Password reset failed' });
  }
});

// Login/Signup with wallet
router.post('/wallet-login', async (req, res) => {
  try {
    const { address } = req.body;
    const walletAddress = normalizeWalletAddress(address);
    if (!walletAddress) {
      return res.status(400).json({ message: 'address is required' });
    }

    // First: resolve via wallet link table (supports multiple wallets per user)
    let link = await WalletLink.findOne({ walletAddress }).lean();
    let user = null;
    if (link?.user) {
      user = await User.findById(link.user);
    }

    // Backward compatibility: if still not found, try legacy User.walletAddress and create link.
    if (!user) {
      user = await User.findOne({ walletAddress });
      if (user) {
        await ensureLegacyWalletLink(user);
      }
    }

    if (!user) return res.status(404).json({ message: 'User not found' });

    const token = generateToken(user._id);
    res.json({ token, user: await toUserResponse(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Signup with wallet
router.post('/wallet-signup', async (req, res) => {
  try {
    const { address } = req.body;
    const walletAddress = normalizeWalletAddress(address);
    if (!walletAddress) {
      return res.status(400).json({ message: 'address is required' });
    }

    // If already linked, return the associated user (don't create duplicates)
    const existingLink = await WalletLink.findOne({ walletAddress }).lean();
    if (existingLink?.user) {
      const existingUser = await User.findById(existingLink.user);
      if (existingUser) {
        const token = generateToken(existingUser._id);
        return res.json({ token, user: await toUserResponse(existingUser) });
      }
    }

    const username = `user_${walletAddress.slice(0, 8)}`;
    const user = new User({ walletAddress, username });
    await user.save();
    await WalletLink.create({ walletAddress, user: user._id });

    const token = generateToken(user._id);
    res.json({ token, user: await toUserResponse(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Check if a wallet can be linked (or is already linked to current user)
router.post('/wallets/check', auth, async (req, res) => {
  try {
    const walletAddress = normalizeWalletAddress(req.body?.address || req.body?.walletAddress);
    if (!walletAddress) return res.status(400).json({ message: 'address is required' });

    const existing = await WalletLink.findOne({ walletAddress }).lean();
    if (!existing) {
      return res.json({ ok: true, status: 'available' });
    }
    if (String(existing.user) === String(req.user._id)) {
      return res.json({ ok: true, status: 'linked_to_me' });
    }
    return res.status(409).json({
      ok: false,
      status: 'in_use',
      message: 'The wallet address is already associated with another account.',
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Link a wallet to the authenticated account (email user can have multiple wallets)
router.post('/wallets/link', auth, async (req, res) => {
  try {
    const address = req.body?.address || req.body?.walletAddress;
    const walletAddress = await linkWalletToUser({ userId: req.user._id, address });
    const user = await User.findById(req.user._id);
    return res.json({ ok: true, walletAddress, user: await toUserResponse(user) });
  } catch (error) {
    if (error?.statusCode === 409 && error?.message === 'WALLET_IN_USE') {
      return res.status(409).json({
        ok: false,
        status: 'in_use',
        message: 'The wallet address is already associated with another account.',
      });
    }
    return res.status(error?.statusCode || 500).json({ message: error.message || 'Failed to link wallet' });
  }
});

// Unlink a wallet from the authenticated account
router.post('/wallets/unlink', auth, async (req, res) => {
  try {
    const walletAddress = normalizeWalletAddress(req.body?.address || req.body?.walletAddress);
    if (!walletAddress) return res.status(400).json({ message: 'address is required' });

    const existing = await WalletLink.findOne({ walletAddress }).lean();
    if (!existing) return res.json({ ok: true, removed: false });
    if (String(existing.user) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Not authorized to unlink this wallet' });
    }
    await WalletLink.deleteOne({ walletAddress });

    // If this wallet was stored in legacy field, clear it (best-effort)
    const u = await User.findById(req.user._id).select('walletAddress').lean();
    if (u?.walletAddress && normalizeWalletAddress(u.walletAddress) === walletAddress) {
      await User.findByIdAndUpdate(req.user._id, { walletAddress: null });
    }

    return res.json({ ok: true, removed: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    await ensureLegacyWalletLink(user);
    res.json({ user: await toUserResponse(user) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
