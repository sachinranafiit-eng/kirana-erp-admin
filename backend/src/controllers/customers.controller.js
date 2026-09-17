const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { logActivity } = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const params = [];
  let where = '';
  if (search) {
    where = 'WHERE name ILIKE $1 OR mobile ILIKE $1 OR gstin ILIKE $1';
    params.push(`%${search}%`);
  }
  const { rows } = await query(`SELECT * FROM customers ${where} ORDER BY name`, params);
  res.json({ success: true, data: rows });
});

const getOne = asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw ApiError.notFound('Customer not found');
  res.json({ success: true, data: rows[0] });
});

const create = asyncHandler(async (req, res) => {
  const b = req.body;
  if (!b.name) throw ApiError.badRequest('name is required');
  const { rows } = await query(
    `INSERT INTO customers (name, mobile, whatsapp, email, address, gstin, state, state_code,
       customer_type, credit_limit, credit_days, opening_balance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      b.name, b.mobile || null, b.whatsapp || null, b.email || null, b.address || null,
      b.gstin || null, b.state || null, b.stateCode || null, b.customerType || 'retail',
      b.creditLimit || 0, b.creditDays || 0, b.openingBalance || 0,
    ]
  );
  await logActivity({ userId: req.user.id, action: 'customers.create', entityType: 'customer', entityId: rows[0].id });
  res.status(201).json({ success: true, data: rows[0] });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const { rows } = await query(
    `UPDATE customers SET
       name = COALESCE($1,name), mobile = COALESCE($2,mobile), whatsapp = COALESCE($3,whatsapp),
       email = COALESCE($4,email), address = COALESCE($5,address), gstin = COALESCE($6,gstin),
       state = COALESCE($7,state), state_code = COALESCE($8,state_code),
       customer_type = COALESCE($9,customer_type), credit_limit = COALESCE($10,credit_limit),
       credit_days = COALESCE($11,credit_days), is_active = COALESCE($12,is_active)
     WHERE id = $13 RETURNING *`,
    [b.name, b.mobile, b.whatsapp, b.email, b.address, b.gstin, b.state, b.stateCode,
      b.customerType, b.creditLimit, b.creditDays, b.isActive, id]
  );
  if (!rows[0]) throw ApiError.notFound('Customer not found');
  await logActivity({ userId: req.user.id, action: 'customers.update', entityType: 'customer', entityId: id });
  res.json({ success: true, data: rows[0] });
});

// Ledger: opening balance + all sales (debit) + all payments (credit).
// Phase 3 (sales) will populate the sales/payments rows this reads from.
const ledger = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const customer = (await query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
  if (!customer) throw ApiError.notFound('Customer not found');

  const sales = (await query(
    `SELECT id, invoice_number, total_amount, created_at FROM sales
     WHERE customer_id = $1 AND status != 'cancelled' ORDER BY created_at`,
    [id]
  )).rows;
  const payments = (await query(
    `SELECT id, amount, mode, created_at FROM payments
     WHERE party_type = 'customer' AND party_id = $1 ORDER BY created_at`,
    [id]
  )).rows;

  const totalSales = sales.reduce((sum, s) => sum + Number(s.total_amount), 0);
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const outstanding = Number(customer.opening_balance) + totalSales - totalPaid;

  res.json({
    success: true,
    data: { customer, sales, payments, totalSales, totalPaid, outstanding },
  });
});

module.exports = { list, getOne, create, update, ledger };
