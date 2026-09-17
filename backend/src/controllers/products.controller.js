const H = require('../services/erp.helpers');
const { query, withTransaction } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { logAudit, logActivity } = require('../utils/audit');

// Strip cost/profit-sensitive fields unless the user has the relevant
// permission. super_admin (empty permissions array by convention in the
// auth middleware) always sees everything.
function maskPricing(product, user) {
  const canViewCost = user.role_name === 'super_admin' || user.permissions.includes('pricing.view_cost_price');
  if (!canViewCost) {
    const { cost_price, ...rest } = product;
    return { ...rest, cost_price: undefined };
  }
  return product;
}

/**
 * Generates a simple, collision-checked EAN-13-shaped internal barcode
 * for products that don't have a manufacturer barcode. Uses a reserved
 * "2" prefix (common convention for in-store/internal codes in India)
 * followed by the product id, padded, plus a check digit.
 */
function computeEan13CheckDigit(digits12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const mod = sum % 10;
  return mod === 0 ? 0 : 10 - mod;
}
function generateInternalBarcode(productId) {
  const body = `2${String(productId).padStart(11, '0')}`;
  const check = computeEan13CheckDigit(body);
  return `${body}${check}`;
}

const list = asyncHandler(async (req, res) => {
  const {
    search, categoryId, brandId, lowStock, outOfStock, isActive, page = 1, pageSize = 50,
  } = req.query;

  const conditions = [];
  const params = [];
  let idx = 1;

  if (search) {
    conditions.push(`(p.name ILIKE $${idx} OR p.sku ILIKE $${idx} OR EXISTS (
      SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode ILIKE $${idx}
    ))`);
    params.push(`%${search}%`);
    idx++;
  }
  if (categoryId) { conditions.push(`p.category_id = $${idx}`); params.push(categoryId); idx++; }
  if (brandId) { conditions.push(`p.brand_id = $${idx}`); params.push(brandId); idx++; }
  if (isActive !== undefined) { conditions.push(`p.is_active = $${idx}`); params.push(isActive === 'true'); idx++; }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Number(pageSize) || 50, 200);
  const offset = (Math.max(Number(page), 1) - 1) * limit;

  const totalStockExpr = `COALESCE((SELECT SUM(s.current_qty) FROM stock s WHERE s.product_id = p.id), 0)`;

  let havingClause = '';
  if (lowStock === 'true') havingClause = `HAVING ${totalStockExpr} <= p.reorder_level AND ${totalStockExpr} > 0`;
  if (outOfStock === 'true') havingClause = `HAVING ${totalStockExpr} <= 0`;

  const sql = `
    SELECT p.*, c.name AS category_name, b.name AS brand_name, u.short_code AS unit_code,
           ${totalStockExpr} AS total_stock,
           (SELECT array_agg(barcode) FROM product_barcodes WHERE product_id = p.id) AS barcodes
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN units u ON u.id = p.unit_id
    ${where}
    GROUP BY p.id, c.name, b.name, u.short_code
    ${havingClause}
    ORDER BY p.name
    LIMIT $${idx} OFFSET $${idx + 1}
  `;
  params.push(limit, offset);

  const { rows } = await query(sql, params);
  const masked = rows.map((r) => maskPricing(r, req.user));
  res.json({ success: true, data: masked, page: Number(page), pageSize: limit });
});

const getOne = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, c.name AS category_name, b.name AS brand_name, u.short_code AS unit_code,
            COALESCE((SELECT SUM(s.current_qty) FROM stock s WHERE s.product_id = p.id), 0) AS total_stock
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN brands b ON b.id = p.brand_id
     LEFT JOIN units u ON u.id = p.unit_id
     WHERE p.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) throw ApiError.notFound('Product not found');

  const barcodes = (await query('SELECT * FROM product_barcodes WHERE product_id = $1', [req.params.id])).rows;
  res.json({ success: true, data: { ...maskPricing(rows[0], req.user), barcodes } });
});

const create = asyncHandler(async (req, res) => {
  const b = req.body;
  b.storeId=H.scope(req.user,b.storeId);
  for(const k of ['costPrice','mrp','salePrice','openingStock','gstRate']) if(b[k]!==undefined)H.number(b[k],k,{scale:k==='openingStock'?3:2});
  if ((b.trackBatches || b.trackExpiry) && Number(b.openingStock)>0) throw ApiError.badRequest('Create this item with zero opening stock, then receive it through Purchases with batch/expiry details');
  if (!b.name || !b.sku || !b.unitId) throw ApiError.badRequest('name, sku and unitId are required');

  if (b.mrp !== undefined && b.salePrice !== undefined && Number(b.salePrice) > Number(b.mrp)) {
    throw ApiError.badRequest('Sale price cannot be greater than MRP');
  }

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO products (
         sku, name, local_name, description, category_id, brand_id, supplier_id, unit_id,
         hsn_code, gst_rate, tax_inclusive, cost_price, mrp, sale_price, wholesale_price,
         min_selling_price, default_discount_pct, pack_size, min_stock_level, max_stock_level,
         reorder_level, rack_location, product_type, track_batches, track_expiry, image_url,
         created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       RETURNING *`,
      [
        b.sku, b.name, b.localName || null, b.description || null, b.categoryId || null,
        b.brandId || null, b.supplierId || null, b.unitId, b.hsnCode || null, b.gstRate || 0,
        b.taxInclusive !== undefined ? b.taxInclusive : true, b.costPrice || 0, b.mrp || 0,
        b.salePrice || 0, b.wholesalePrice || null, b.minSellingPrice || null,
        b.defaultDiscountPct || 0, b.packSize || null, b.minStockLevel || 0, b.maxStockLevel || null,
        b.reorderLevel || 0, b.rackLocation || null, b.productType || 'standard',
        b.trackBatches || false, b.trackExpiry || false, b.imageUrl || null, req.user.id,
      ]
    );
    const product = rows[0];

    // Barcode: use provided one, or auto-generate a system barcode.
    const barcode = b.barcode && b.barcode.trim() ? b.barcode.trim() : generateInternalBarcode(product.id);
    await client.query(
      'INSERT INTO product_barcodes (product_id, barcode, is_system_generated) VALUES ($1,$2,$3)',
      [product.id, barcode, !(b.barcode && b.barcode.trim())]
    );

    // Opening stock, if provided, becomes the first stock_movements entry
    // and seeds the stock aggregate — never written directly.
    if (b.openingStock && Number(b.openingStock) > 0 && b.storeId) {
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, movement_type, qty_in, cost_rate, reference_type, notes, created_by)
         VALUES ($1,$2,'opening',$3,$4,'opening_stock','Opening stock at product creation',$5)`,
        [b.storeId, product.id, b.openingStock, b.costPrice || 0, req.user.id]
      );
      await client.query(
        `INSERT INTO stock (store_id, product_id, current_qty) VALUES ($1,$2,$3)
         ON CONFLICT (store_id, product_id, batch_id) DO UPDATE SET current_qty = stock.current_qty + EXCLUDED.current_qty`,
        [b.storeId, product.id, b.openingStock]
      );
    }

    await logAudit({ client, userId: req.user.id, tableName: 'products', recordId: product.id, operation: 'INSERT', newData: product });
    return { ...product, barcode };
  });

  await logActivity({ userId: req.user.id, action: 'products.create', entityType: 'product', entityId: result.id });
  res.status(201).json({ success: true, data: maskPricing(result, req.user) });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const b = req.body;

  const existing = (await query('SELECT * FROM products WHERE id = $1', [id])).rows[0];
  if (!existing) throw ApiError.notFound('Product not found');

  if (Number(b.salePrice??existing.sale_price)>Number(b.mrp??existing.mrp))throw ApiError.badRequest('Selling price exceeds MRP');
  for(const k of ['costPrice','mrp','salePrice','gstRate'])if(b[k]!==undefined)H.number(b[k],k,{scale:2});
  // Enforce field-level permission: only users with pricing.change_selling_price
  // may alter sale_price/mrp; everyone with products.edit can change the rest.
  const canChangePrice = req.user.role_name === 'super_admin'
    || req.user.permissions.includes('pricing.change_selling_price');
  if (!canChangePrice && (b.salePrice !== undefined || b.mrp !== undefined)) {
    throw ApiError.forbidden('You do not have permission to change selling price / MRP');
  }

  const { rows } = await query(
    `UPDATE products SET
       name = COALESCE($1,name), local_name = COALESCE($2,local_name),
       description = COALESCE($3,description), category_id = COALESCE($4,category_id),
       brand_id = COALESCE($5,brand_id), supplier_id = COALESCE($6,supplier_id),
       hsn_code = COALESCE($7,hsn_code), gst_rate = COALESCE($8,gst_rate),
       cost_price = COALESCE($9,cost_price), mrp = COALESCE($10,mrp),
       sale_price = COALESCE($11,sale_price), wholesale_price = COALESCE($12,wholesale_price),
       min_selling_price = COALESCE($13,min_selling_price), reorder_level = COALESCE($14,reorder_level),
       min_stock_level = COALESCE($15,min_stock_level), max_stock_level = COALESCE($16,max_stock_level),
       rack_location = COALESCE($17,rack_location), is_active = COALESCE($18,is_active)
     WHERE id = $19 RETURNING *`,
    [
      b.name, b.localName, b.description, b.categoryId, b.brandId, b.supplierId,
      b.hsnCode, b.gstRate, b.costPrice, b.mrp, b.salePrice, b.wholesalePrice,
      b.minSellingPrice, b.reorderLevel, b.minStockLevel, b.maxStockLevel,
      b.rackLocation, b.isActive, id,
    ]
  );

  await logAudit({ userId: req.user.id, tableName: 'products', recordId: id, operation: 'UPDATE', oldData: existing, newData: rows[0] });
  await logActivity({ userId: req.user.id, action: 'products.update', entityType: 'product', entityId: id });

  res.json({ success: true, data: maskPricing(rows[0], req.user) });
});

const addBarcode = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { barcode } = req.body;
  const code = barcode && barcode.trim() ? barcode.trim() : generateInternalBarcode(id);

  const dup = await query('SELECT product_id FROM product_barcodes WHERE barcode = $1', [code]);
  if (dup.rows[0]) throw ApiError.conflict(`Barcode ${code} is already assigned to product #${dup.rows[0].product_id}`);

  const { rows } = await query(
    'INSERT INTO product_barcodes (product_id, barcode, is_system_generated) VALUES ($1,$2,$3) RETURNING *',
    [id, code, !(barcode && barcode.trim())]
  );
  await logActivity({ userId: req.user.id, action: 'products.barcode_added', entityType: 'product', entityId: id, details: { barcode: code } });
  res.status(201).json({ success: true, data: rows[0] });
});

const findByBarcode = asyncHandler(async (req, res) => {
  const { code } = req.params;
  const { rows } = await query(
    `SELECT p.* FROM products p
     JOIN product_barcodes pb ON pb.product_id = p.id
     WHERE pb.barcode = $1 AND p.is_active = true`,
    [code]
  );
  if (!rows[0]) throw ApiError.notFound(`No active product found for barcode ${code}`);
  res.json({ success: true, data: maskPricing(rows[0], req.user) });
});

const deactivate = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const result = await query('UPDATE products SET is_active = false WHERE id = $1 RETURNING id, name', [id]);
  if (!result.rows[0]) throw ApiError.notFound('Product not found');
  await logActivity({ userId: req.user.id, action: 'products.deactivate', entityType: 'product', entityId: id });
  res.json({ success: true, message: 'Product deactivated' });
});

module.exports = { list, getOne, create, update, addBarcode, findByBarcode, deactivate };
