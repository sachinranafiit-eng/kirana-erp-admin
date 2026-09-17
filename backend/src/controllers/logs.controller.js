const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');

const activity = asyncHandler(async (req, res) => {
  const { userId, action, from, to, page = 1, pageSize = 100 } = req.query;
  const conditions = [];
  const params = [];
  let idx = 1;

  if (userId) { conditions.push(`a.user_id = $${idx}`); params.push(userId); idx++; }
  if (action) { conditions.push(`a.action ILIKE $${idx}`); params.push(`%${action}%`); idx++; }
  if (from) { conditions.push(`a.created_at >= $${idx}`); params.push(from); idx++; }
  if (to) { conditions.push(`a.created_at <= $${idx}`); params.push(to); idx++; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(pageSize) || 100, 500);
  const offset = (Math.max(Number(page), 1) - 1) * limit;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT a.*, u.full_name, u.username FROM user_activity_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ${where}
     ORDER BY a.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );
  res.json({ success: true, data: rows, page: Number(page), pageSize: limit });
});

const logins = asyncHandler(async (req, res) => {
  const { success, page = 1, pageSize = 100 } = req.query;
  const conditions = [];
  const params = [];
  let idx = 1;
  if (success !== undefined) { conditions.push(`l.success = $${idx}`); params.push(success === 'true'); idx++; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(pageSize) || 100, 500);
  const offset = (Math.max(Number(page), 1) - 1) * limit;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT l.*, u.full_name FROM login_logs l LEFT JOIN users u ON u.id = l.user_id
     ${where} ORDER BY l.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );
  res.json({ success: true, data: rows, page: Number(page), pageSize: limit });
});

module.exports = { activity, logins };
