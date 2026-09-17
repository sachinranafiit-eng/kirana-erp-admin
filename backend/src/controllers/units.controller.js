const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { logActivity } = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM units ORDER BY name');
  res.json({ success: true, data: rows });
});

const create = asyncHandler(async (req, res) => {
  const { name, shortCode } = req.body;
  if (!name || !shortCode) throw ApiError.badRequest('name and shortCode are required');
  const { rows } = await query(
    'INSERT INTO units (name, short_code) VALUES ($1,$2) RETURNING *',
    [name, shortCode]
  );
  await logActivity({ userId: req.user.id, action: 'units.create', entityType: 'unit', entityId: rows[0].id });
  res.status(201).json({ success: true, data: rows[0] });
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const inUse = await query('SELECT 1 FROM products WHERE unit_id = $1 LIMIT 1', [id]);
  if (inUse.rows[0]) throw ApiError.conflict('Cannot delete a unit that is used by products.');
  const result = await query('DELETE FROM units WHERE id = $1 RETURNING id', [id]);
  if (!result.rows[0]) throw ApiError.notFound('Unit not found');
  await logActivity({ userId: req.user.id, action: 'units.delete', entityType: 'unit', entityId: id });
  res.json({ success: true, message: 'Unit deleted' });
});

module.exports = { list, create, remove };
