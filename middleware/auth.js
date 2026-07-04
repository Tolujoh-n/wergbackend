const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { BAN_MESSAGE } = require('../services/userBanService');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ message: 'No token, authorization denied' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.status(401).json({ message: 'Token is not valid' });
    }

    if (user.banned) {
      return res.status(403).json({ message: BAN_MESSAGE, code: 'ACCOUNT_BANNED' });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

const isAdmin = async (req, res, next) => {
  const { userHasAdminAccess } = require('../services/contractAdminAccess');
  const ok = await userHasAdminAccess(req.user);
  if (!ok) {
    return res.status(403).json({ message: 'Access denied. Admin only.' });
  }
  next();
};

const isSuperAdmin = async (req, res, next) => {
  if (req.user.role !== 'superAdmin') {
    return res.status(403).json({ message: 'Access denied. SuperAdmin only.' });
  }
  next();
};

/** Sets `req.user` when a valid Bearer token is present; otherwise continues without user. */
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return next();
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const user = await User.findById(decoded.userId).select('-password');
    if (user) req.user = user;
  } catch (_) {
    /* ignore invalid token for optional routes */
  }
  next();
};

module.exports = { auth, optionalAuth, isAdmin, isSuperAdmin };
