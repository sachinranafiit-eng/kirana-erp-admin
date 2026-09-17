const jwt = require('jsonwebtoken');
const ApiError = require('../utils/ApiError');
const { query } = require('../config/db');

async function authenticateCustomer(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw ApiError.unauthorized('Please log in to continue');

    let payload;
    try {
      payload = jwt.verify(token, process.env.CUSTOMER_JWT_SECRET);
    } catch (e) {
      throw ApiError.unauthorized('Session expired — please log in again');
    }
    if (payload.type !== 'customer') throw ApiError.unauthorized('Invalid session');

    const { rows } = await query('SELECT * FROM customers WHERE id = $1 AND is_active = true', [payload.sub]);
    if (!rows[0]) throw ApiError.unauthorized('Account not found or deactivated');

    req.customer = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authenticateCustomer };
