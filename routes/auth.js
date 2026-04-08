const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
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
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
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
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, role: user.role } });
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
    const walletAddress = address.toLowerCase();

    let user = await User.findOne({ walletAddress });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const token = generateToken(user._id);
    res.json({ token, user: { id: user._id, username: user.username, walletAddress: user.walletAddress, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Signup with wallet
router.post('/wallet-signup', async (req, res) => {
  try {
    const { address } = req.body;
    const walletAddress = address.toLowerCase();

    let user = await User.findOne({ walletAddress });
    if (user) {
      const token = generateToken(user._id);
      return res.json({ token, user: { id: user._id, username: user.username, walletAddress: user.walletAddress, role: user.role } });
    }

    const username = `user_${walletAddress.slice(0, 8)}`;
    user = new User({ walletAddress, username });
    await user.save();

    const token = generateToken(user._id);
    res.json({ token, user: { id: user._id, username: user.username, walletAddress: user.walletAddress, role: user.role } });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json({ user });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
