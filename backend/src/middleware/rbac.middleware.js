const ApiError = require('../utils/ApiError');
const bcrypt = require('bcryptjs');
const { query } = require('../config/db');

/**
 * requirePermission('products.edit') — blocks the request unless the
 * authenticated user's role has that permission code (or is super_admin).
 * Must run after `authenticate`.
 */
function requirePermission(...permissionCodes) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role_name === 'super_admin') return next();

    const hasAll = permissionCodes.every((code) => req.user.permissions.includes(code));
    if (!hasAll) {
      return next(ApiError.forbidden(
        `This action requires permission: ${permissionCodes.join(', ')}`
      ));
    }
    next();
  };
}

/**
 * requirePin — for sensitive actions (invoice cancel, stock adjustment,
 * purchase approval). Expects `req.body.pin` and checks it against the
 * logged-in user's stored PIN hash. If no PIN is configured for the user,
 * this step is skipped (opt-in security feature).
 */
async function requirePin(req, res, next) {
  try {
    const { rows } = await query('SELECT pin_hash FROM users WHERE id = $1', [req.user.id]);
    const pinHash = rows[0] && rows[0].pin_hash;
    if (!pinHash) return next(); // PIN not configured for this user — skip

    const provided = req.body.pin;
    if (!provided) throw ApiError.badRequest('Admin PIN is required for this action');

    const ok = await bcrypt.compare(String(provided), pinHash);
    if (!ok) throw ApiError.forbidden('Incorrect PIN');
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requirePermission, requirePin };
