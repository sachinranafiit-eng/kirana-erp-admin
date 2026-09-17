const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { logActivity } = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM brands ORDER BY name');
  res.json({ success: true, data: rows });
});

const create = asyncHandler(async (req, res) => {
  const { name, manufacturer } = req.body;
  if (!name) throw ApiError.badRequest('name is required');
  const { rows } = await query(
    'INSERT INTO brands (name, manufacturer) VALUES ($1,$2) RETURNING *',
    [name, manufacturer || null]
  );
  await logActivity({ userId: req.user.id, action: 'brands.create', entityType: 'brand', entityId: rows[0].id });
  res.status(201).json({ success: true, data: rows[0] });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, manufacturer, isActive } = req.body;
  const { rows } = await query(
    `UPDATE brands SET name = COALESCE($1,name), manufacturer = COALESCE($2,manufacturer),
     is_active = COALESCE($3,is_active) WHERE id = $4 RETURNING *`,
    [name, manufacturer, isActive, id]
  );
  if (!rows[0]) throw ApiError.notFound('Brand not found');
  await logActivity({ userId: req.user.id, action: 'brands.update', entityType: 'brand', entityId: id });
  res.json({ success: true, data: rows[0] });
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const inUse = await query('SELECT 1 FROM products WHERE brand_id = $1 LIMIT 1', [id]);
  if (inUse.rows[0]) throw ApiError.conflict('Cannot delete a brand that has products. Deactivate it instead.');
  const result = await query('DELETE FROM brands WHERE id = $1 RETURNING id', [id]);
  if (!result.rows[0]) throw ApiError.notFound('Brand not found');
  await logActivity({ userId: req.user.id, action: 'brands.delete', entityType: 'brand', entityId: id });
  res.json({ success: true, message: 'Brand deleted' });
});

module.exports = { list, create, update, remove };
