const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const notificationService = require('../services/notification.service');
const { logActivity } = require('../utils/audit');

const listTemplates = asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM notification_templates ORDER BY code');
  res.json({ success: true, data: rows });
});

const createTemplate = asyncHandler(async (req, res) => {
  const { code, channel, name, bodyTemplate, variables } = req.body;
  if (!code || !channel || !name || !bodyTemplate) {
    throw ApiError.badRequest('code, channel, name and bodyTemplate are required');
  }
  const { rows } = await query(
    `INSERT INTO notification_templates (code, channel, name, body_template, variables)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [code, channel, name, bodyTemplate, JSON.stringify(variables || [])]
  );
  res.status(201).json({ success: true, data: rows[0] });
});

const updateTemplate = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, bodyTemplate, variables, isActive } = req.body;
  const { rows } = await query(
    `UPDATE notification_templates SET
       name = COALESCE($1,name), body_template = COALESCE($2,body_template),
       variables = COALESCE($3,variables), is_active = COALESCE($4,is_active)
     WHERE id = $5 RETURNING *`,
    [name, bodyTemplate, variables ? JSON.stringify(variables) : null, isActive, id]
  );
  if (!rows[0]) throw ApiError.notFound('Template not found');
  res.json({ success: true, data: rows[0] });
});

// Ad-hoc single send — e.g. "share this invoice PDF link with the customer".
const send = asyncHandler(async (req, res) => {
  const { channel, to, templateCode, variables, customerId, supplierId } = req.body;
  if (!channel || !to || !templateCode) {
    throw ApiError.badRequest('channel, to and templateCode are required');
  }
  const partyType = customerId ? 'customer' : supplierId ? 'supplier' : 'ad_hoc';
  const partyId = customerId || supplierId || null;

  const result = await notificationService.sendTemplatedMessage({
    channel, to, templateCode, variables: variables || {}, partyType, partyId, userId: req.user.id,
  });

  await logActivity({ userId: req.user.id, action: 'notifications.send', entityType: partyType, entityId: partyId, details: { channel, templateCode, status: result.status } });

  if (result.status === 'failed') {
    return res.status(502).json({ success: false, message: 'Message could not be delivered', details: result.error });
  }
  res.json({ success: true, data: result });
});

// Payment reminder — computes live outstanding from the customer ledger
// and sends the 'payment_reminder' template.
const paymentReminder = asyncHandler(async (req, res) => {
  const { customerId } = req.body;
  const { channel } = req.body;
  if (!customerId || !channel) throw ApiError.badRequest('customerId and channel are required');

  const customer = (await query('SELECT * FROM customers WHERE id = $1', [customerId])).rows[0];
  if (!customer) throw ApiError.notFound('Customer not found');
  if (!customer.mobile) throw ApiError.badRequest('This customer has no mobile number on file');

  const sales = (await query(
    `SELECT COALESCE(SUM(total_amount),0) AS total FROM sales WHERE customer_id = $1 AND status != 'cancelled'`,
    [customerId]
  )).rows[0];
  const payments = (await query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM payments WHERE party_type = 'customer' AND party_id = $1`,
    [customerId]
  )).rows[0];
  const outstanding = Number(customer.opening_balance) + Number(sales.total) - Number(payments.total);

  if (outstanding <= 0) {
    return res.json({ success: true, message: 'No outstanding balance — reminder not sent', outstanding });
  }

  const shopName = (await query("SELECT value FROM settings WHERE key = 'online_store_name'")).rows[0];

  const result = await notificationService.sendTemplatedMessage({
    channel, to: customer.mobile, templateCode: 'payment_reminder',
    variables: { name: customer.name, shopName: shopName ? JSON.parse(shopName.value) : 'the store', outstanding: outstanding.toFixed(2) },
    partyType: 'customer', partyId: customerId, userId: req.user.id,
  });

  await logActivity({ userId: req.user.id, action: 'notifications.payment_reminder', entityType: 'customer', entityId: customerId, details: { outstanding } });

  res.json({ success: true, data: result, outstanding });
});

// Marketing broadcast to a filtered customer segment. Body:
// { channel, templateCode, variables, filter: { customerType, minTotalPurchase } }
const broadcast = asyncHandler(async (req, res) => {
  const { channel, templateCode, variables, filter = {} } = req.body;
  if (!channel || !templateCode) throw ApiError.badRequest('channel and templateCode are required');

  const conditions = ['mobile IS NOT NULL', 'is_active = true'];
  const params = [];
  let idx = 1;
  if (filter.customerType) { conditions.push(`customer_type = $${idx}`); params.push(filter.customerType); idx++; }

  const { rows: customers } = await query(
    `SELECT id, name, mobile FROM customers WHERE ${conditions.join(' AND ')}`,
    params
  );

  const recipients = customers.map((c) => ({
    to: c.mobile,
    partyType: 'customer',
    partyId: c.id,
    variables: { name: c.name, ...variables },
  }));

  const results = await notificationService.broadcast({
    channel, templateCode, recipients, isMarketing: true, userId: req.user.id,
  });

  await logActivity({
    userId: req.user.id, action: 'notifications.broadcast',
    details: { channel, templateCode, recipientCount: recipients.length, filter },
  });

  const sent = results.filter((r) => r.status === 'sent').length;
  const skipped = results.filter((r) => r.status === 'skipped_opt_out').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  res.json({ success: true, summary: { total: results.length, sent, skipped, failed }, data: results });
});

const logs = asyncHandler(async (req, res) => {
  const { partyId, partyType, status, page = 1, pageSize = 100 } = req.query;
  const conditions = [];
  const params = [];
  let idx = 1;
  if (partyId) { conditions.push(`party_id = $${idx}`); params.push(partyId); idx++; }
  if (partyType) { conditions.push(`party_type = $${idx}`); params.push(partyType); idx++; }
  if (status) { conditions.push(`status = $${idx}`); params.push(status); idx++; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(pageSize) || 100, 500);
  const offset = (Math.max(Number(page), 1) - 1) * limit;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT * FROM notifications_log ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );
  res.json({ success: true, data: rows, page: Number(page), pageSize: limit });
});

module.exports = { listTemplates, createTemplate, updateTemplate, send, paymentReminder, broadcast, logs };
