const jwt = require('jsonwebtoken');
const User = require('../models/User');

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

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

const isAdmin = async (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
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

module.exports = { auth, isAdmin, isSuperAdmin };
