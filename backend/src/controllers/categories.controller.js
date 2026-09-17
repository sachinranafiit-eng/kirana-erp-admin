const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { logActivity } = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT c.*, p.name AS parent_name FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     ORDER BY c.name`
  );
  res.json({ success: true, data: rows });
});

const create = asyncHandler(async (req, res) => {
  const { name, parentId } = req.body;
  if (!name) throw ApiError.badRequest('name is required');
  const { rows } = await query(
    'INSERT INTO categories (name, parent_id) VALUES ($1,$2) RETURNING *',
    [name, parentId || null]
  );
  await logActivity({ userId: req.user.id, action: 'categories.create', entityType: 'category', entityId: rows[0].id });
  res.status(201).json({ success: true, data: rows[0] });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, parentId, isActive } = req.body;
  const { rows } = await query(
    `UPDATE categories SET name = COALESCE($1,name), parent_id = COALESCE($2,parent_id),
     is_active = COALESCE($3,is_active) WHERE id = $4 RETURNING *`,
    [name, parentId, isActive, id]
  );
  if (!rows[0]) throw ApiError.notFound('Category not found');
  await logActivity({ userId: req.user.id, action: 'categories.update', entityType: 'category', entityId: id });
  res.json({ success: true, data: rows[0] });
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const inUse = await query('SELECT 1 FROM products WHERE category_id = $1 LIMIT 1', [id]);
  if (inUse.rows[0]) {
    throw ApiError.conflict('Cannot delete a category that has products. Deactivate it instead.');
  }
  const result = await query('DELETE FROM categories WHERE id = $1 RETURNING id', [id]);
  if (!result.rows[0]) throw ApiError.notFound('Category not found');
  await logActivity({ userId: req.user.id, action: 'categories.delete', entityType: 'category', entityId: id });
  res.json({ success: true, message: 'Category deleted' });
});

module.exports = { list, create, update, remove };
