const H = require('../services/erp.helpers');
const { query } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { logActivity } = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const params = [];
  let where = '';
  if (search) {
    where = 'WHERE company_name ILIKE $1 OR mobile ILIKE $1 OR gstin ILIKE $1';
    params.push(`%${search}%`);
  }
  const { rows } = await query(`SELECT * FROM suppliers ${where} ORDER BY company_name`, params);
  res.json({ success: true, data: rows });
});

const getOne = asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw ApiError.notFound('Supplier not found');
  res.json({ success: true, data: rows[0] });
});

const create = asyncHandler(async (req, res) => {
  const b = req.body;
  H.gstin(b.gstin,b.stateCode);
  if (b.registrationType && !['regular','composition','unregistered'].includes(b.registrationType)) throw ApiError.badRequest('Invalid GST registration type');
  if (b.registrationType && b.registrationType !== 'unregistered' && !b.gstin) throw ApiError.badRequest('Supplier GSTIN is required');
  if (!b.companyName) throw ApiError.badRequest('companyName is required');
  const { rows } = await query(
    `INSERT INTO suppliers (company_name, contact_person, mobile, email, address, gstin, pan,
       state, state_code, opening_balance, credit_period_days, supplier_code, registration_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      b.companyName, b.contactPerson || null, b.mobile || null, b.email || null,
      b.address || null, b.gstin || null, b.pan || null, b.state || null,
      b.stateCode || null, b.openingBalance || 0, b.creditPeriodDays || 0,b.supplierCode || null,b.registrationType || (b.gstin?'regular':'unregistered'),
    ]
  );
  await logActivity({ userId: req.user.id, action: 'suppliers.create', entityType: 'supplier', entityId: rows[0].id });
  if(!rows[0].supplier_code) { rows[0].supplier_code='SUP-'+rows[0].id; await query('UPDATE suppliers SET supplier_code=$1 WHERE id=$2',[rows[0].supplier_code,rows[0].id]); }
  res.status(201).json({ success: true, data: rows[0] });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body;
  const { rows } = await query(
    `UPDATE suppliers SET
       company_name = COALESCE($1,company_name), contact_person = COALESCE($2,contact_person),
       mobile = COALESCE($3,mobile), email = COALESCE($4,email), address = COALESCE($5,address),
       gstin = COALESCE($6,gstin), pan = COALESCE($7,pan), state = COALESCE($8,state),
       state_code = COALESCE($9,state_code), credit_period_days = COALESCE($10,credit_period_days),
       is_active = COALESCE($11,is_active), supplier_code = COALESCE($13,supplier_code), registration_type = COALESCE($14,registration_type)
     WHERE id = $12 RETURNING *`,
    [b.companyName, b.contactPerson, b.mobile, b.email, b.address, b.gstin, b.pan,
      b.state, b.stateCode, b.creditPeriodDays, b.isActive, id,b.supplierCode,b.registrationType]
  );
  if (!rows[0]) throw ApiError.notFound('Supplier not found');
  await logActivity({ userId: req.user.id, action: 'suppliers.update', entityType: 'supplier', entityId: id });
  res.json({ success: true, data: rows[0] });
});

// Ledger: opening balance + purchases (payable increases) - payments made.
const ledger = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const supplier = (await query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0];
  if (!supplier) throw ApiError.notFound('Supplier not found');

  const purchases = (await query(
    `SELECT id, invoice_number, total_amount, created_at FROM purchases
     WHERE supplier_id = $1 ORDER BY created_at`,
    [id]
  )).rows;
  const payments = (await query(
    `SELECT id, amount, mode, created_at FROM payments
     WHERE party_type = 'supplier' AND party_id = $1 ORDER BY created_at`,
    [id]
  )).rows;

  const totalPurchases = purchases.reduce((sum, p) => sum + Number(p.total_amount), 0);
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const payable = Number(supplier.opening_balance) + totalPurchases - totalPaid;

  res.json({
    success: true,
    data: { supplier, purchases, payments, totalPurchases, totalPaid, payable },
  });
});

module.exports = { list, getOne, create, update, ledger };
