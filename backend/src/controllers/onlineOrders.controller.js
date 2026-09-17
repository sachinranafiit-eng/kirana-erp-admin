const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const notificationService = require('../services/notification.service');
const { logActivity } = require('../utils/audit');

const VALID_STATUSES = ['pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled', 'returned'];

const list = asyncHandler(async (req, res) => {
  const { status, page = 1, pageSize = 50 } = req.query;
  const conditions = [];
  const params = [];
  let idx = 1;
  if (status) { conditions.push(`o.status = $${idx}`); params.push(status); idx++; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(pageSize) || 50, 200);
  const offset = (Math.max(Number(page), 1) - 1) * limit;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT o.*, c.name AS customer_name, c.mobile AS customer_mobile
     FROM online_orders o JOIN customers c ON c.id = o.customer_id
     ${where} ORDER BY o.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );
  res.json({ success: true, data: rows, page: Number(page), pageSize: limit });
});

const getOne = asyncHandler(async (req, res) => {
  const order = (await query(
    `SELECT o.*, c.name AS customer_name, c.mobile AS customer_mobile
     FROM online_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [req.params.id]
  )).rows[0];
  if (!order) throw ApiError.notFound('Order not found');

  const items = (await query(
    `SELECT oi.*, p.name FROM online_order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
    [order.id]
  )).rows;
  const history = (await query(
    'SELECT h.*, u.full_name AS changed_by_name FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE order_id = $1 ORDER BY h.created_at',
    [order.id]
  )).rows;

  res.json({ success: true, data: { ...order, items, history } });
});

const updateStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, notes, notifyCustomer = true, channel = 'sms' } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    throw ApiError.badRequest(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const order = (await query(
    `SELECT o.*, c.name AS customer_name, c.mobile AS customer_mobile
     FROM online_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
    [id]
  )).rows[0];
  if (!order) throw ApiError.notFound('Order not found');

  await query('UPDATE online_orders SET status = $1 WHERE id = $2', [status, id]);
  await query(
    'INSERT INTO order_status_history (order_id, status, notes, changed_by) VALUES ($1,$2,$3,$4)',
    [id, status, notes || null, req.user.id]
  );
  await logActivity({ userId: req.user.id, action: 'online_orders.status_update', entityType: 'online_order', entityId: id, details: { status } });

  if (notifyCustomer && order.customer_mobile) {
    notificationService.sendTemplatedMessage({
      channel, to: order.customer_mobile, templateCode: 'order_status_update',
      variables: { name: order.customer_name, orderNumber: order.order_number, status, extraNote: notes || '' },
      partyType: 'customer', partyId: order.customer_id, userId: req.user.id,
    }).catch(() => {});
  }

  res.json({ success: true, message: 'Order status updated' });
});

// Online store settings — reuses the generic key/value `settings` table.
const STORE_SETTING_KEYS = [
  'online_store_enabled', 'online_store_name', 'online_store_delivery_charge',
  'online_store_min_order_amount', 'online_store_banner_text', 'online_store_url',
];

const getSettings = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT key, value FROM settings WHERE key = ANY($1)`,
    [STORE_SETTING_KEYS]
  );
  const settings = {};
  rows.forEach((r) => { settings[r.key] = JSON.parse(r.value); });
  res.json({ success: true, data: settings });
});

const updateSettings = asyncHandler(async (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates).filter((k) => STORE_SETTING_KEYS.includes(k));
  if (keys.length === 0) throw ApiError.badRequest('No valid settings provided');

  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(updates[key]), req.user.id]
    );
  }
  await logActivity({ userId: req.user.id, action: 'online_store.settings_updated', details: updates });
  res.json({ success: true, message: 'Settings updated' });
});

// Toggle a product's online-store visibility (part of the Product Master
// screen for admin/inventory roles, exposed here for convenience).
const setProductVisibility = asyncHandler(async (req, res) => {
  const { productId } = req.params;
  const { isOnlineVisible, onlineDescription, onlineImages } = req.body;
  const { rows } = await query(
    `UPDATE products SET
       is_online_visible = COALESCE($1, is_online_visible),
       online_description = COALESCE($2, online_description),
       online_images = COALESCE($3, online_images)
     WHERE id = $4 RETURNING id, name, is_online_visible`,
    [isOnlineVisible, onlineDescription, onlineImages ? JSON.stringify(onlineImages) : null, productId]
  );
  if (!rows[0]) throw ApiError.notFound('Product not found');
  res.json({ success: true, data: rows[0] });
});

module.exports = { list, getOne, updateStatus, getSettings, updateSettings, setProductVisibility };
