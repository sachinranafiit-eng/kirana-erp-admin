const jwt = require('jsonwebtoken');
const { query, withTransaction } = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const otpService = require('../services/otp.service');
const notificationService = require('../services/notification.service');

async function getSetting(key, fallback = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? JSON.parse(rows[0].value) : fallback;
}

// ---------------------------------------------------------------------
// CATALOG (public, no auth)
// ---------------------------------------------------------------------
const listCatalog = asyncHandler(async (req, res) => {
  const storeEnabled = await getSetting('online_store_enabled', false);
  if (!storeEnabled) throw ApiError.notFound('Online store is currently unavailable');

  const { search, categoryId, page = 1, pageSize = 30 } = req.query;
  const conditions = ['p.is_online_visible = true', 'p.is_active = true'];
  const params = [];
  let idx = 1;
  if (search) { conditions.push(`p.name ILIKE $${idx}`); params.push(`%${search}%`); idx++; }
  if (categoryId) { conditions.push(`p.category_id = $${idx}`); params.push(categoryId); idx++; }

  const limit = Math.min(Number(pageSize) || 30, 100);
  const offset = (Math.max(Number(page), 1) - 1) * limit;
  params.push(limit, offset);

  const { rows } = await query(
    `SELECT p.id, p.name, p.local_name, p.online_description, p.online_images, p.sale_price,
            p.mrp, p.unit_id, u.short_code AS unit, p.gst_rate, c.name AS category_name,
            COALESCE((SELECT SUM(s.current_qty) FROM stock s WHERE s.product_id = p.id), 0) AS available_qty
     FROM products p
     LEFT JOIN units u ON u.id = p.unit_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY p.name
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );
  res.json({ success: true, data: rows, page: Number(page), pageSize: limit });
});

const getCatalogItem = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT p.id, p.name, p.local_name, p.online_description, p.online_images, p.sale_price,
            p.mrp, p.unit_id, u.short_code AS unit, p.gst_rate,
            COALESCE((SELECT SUM(s.current_qty) FROM stock s WHERE s.product_id = p.id), 0) AS available_qty
     FROM products p LEFT JOIN units u ON u.id = p.unit_id
     WHERE p.id = $1 AND p.is_online_visible = true AND p.is_active = true`,
    [req.params.id]
  );
  if (!rows[0]) throw ApiError.notFound('Product not found or not available online');
  res.json({ success: true, data: rows[0] });
});

// ---------------------------------------------------------------------
// AUTH (OTP-based — no separate password to manage)
// ---------------------------------------------------------------------
const requestOtp = asyncHandler(async (req, res) => {
  const { mobile } = req.body;
  const shopName = await getSetting('online_store_name', 'the store');
  const result = await otpService.requestOtp({ mobile, shopName });
  res.json({ success: true, message: 'OTP sent', ...result });
});

const verifyOtp = asyncHandler(async (req, res) => {
  const { mobile, otp, name } = req.body;
  await otpService.verifyOtp({ mobile, otp });

  // Find or create the customer record — same `customers` table used
  // by in-shop POS, so purchase history is unified across channels.
  let customer = (await query('SELECT * FROM customers WHERE mobile = $1', [mobile])).rows[0];
  if (!customer) {
    const created = await query(
      `INSERT INTO customers (name, mobile, is_online_registered, online_last_login_at)
       VALUES ($1,$2,true,now()) RETURNING *`,
      [name || `Customer ${mobile}`, mobile]
    );
    customer = created.rows[0];
  } else {
    await query(
      'UPDATE customers SET is_online_registered = true, online_last_login_at = now() WHERE id = $1',
      [customer.id]
    );
  }

  const token = jwt.sign({ sub: customer.id, type: 'customer' }, process.env.CUSTOMER_JWT_SECRET, {
    expiresIn: process.env.CUSTOMER_JWT_EXPIRES_IN || '30d',
  });

  res.json({ success: true, data: { token, customer: { id: customer.id, name: customer.name, mobile: customer.mobile } } });
});

// ---------------------------------------------------------------------
// CART (requires customer auth)
// ---------------------------------------------------------------------
const getCart = asyncHandler(async (req, res) => {
  const cart = await ensureCart(req.customer.id);
  const items = (await query(
    `SELECT ci.id, ci.product_id, ci.quantity, p.name, p.sale_price, p.mrp, u.short_code AS unit,
            (ci.quantity * p.sale_price) AS line_total
     FROM cart_items ci JOIN products p ON p.id = ci.product_id
     LEFT JOIN units u ON u.id = p.unit_id
     WHERE ci.cart_id = $1 ORDER BY ci.added_at`,
    [cart.id]
  )).rows;
  const subtotal = items.reduce((sum, i) => sum + Number(i.line_total), 0);
  res.json({ success: true, data: { cartId: cart.id, items, subtotal } });
});

async function ensureCart(customerId) {
  const existing = await query('SELECT * FROM carts WHERE customer_id = $1', [customerId]);
  if (existing.rows[0]) return existing.rows[0];
  const created = await query('INSERT INTO carts (customer_id) VALUES ($1) RETURNING *', [customerId]);
  return created.rows[0];
}

const addToCart = asyncHandler(async (req, res) => {
  const { productId, quantity } = req.body;
  if (!productId || !quantity || Number(quantity) <= 0) {
    throw ApiError.badRequest('productId and a positive quantity are required');
  }
  const product = (await query(
    'SELECT id FROM products WHERE id = $1 AND is_online_visible = true AND is_active = true', [productId]
  )).rows[0];
  if (!product) throw ApiError.notFound('Product not available online');

  const cart = await ensureCart(req.customer.id);
  await query(
    `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1,$2,$3)
     ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
    [cart.id, productId, quantity]
  );
  res.status(201).json({ success: true, message: 'Added to cart' });
});

const updateCartItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const { quantity } = req.body;
  const cart = await ensureCart(req.customer.id);

  if (Number(quantity) <= 0) {
    await query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [itemId, cart.id]);
    return res.json({ success: true, message: 'Item removed' });
  }
  const result = await query(
    'UPDATE cart_items SET quantity = $1 WHERE id = $2 AND cart_id = $3 RETURNING *',
    [quantity, itemId, cart.id]
  );
  if (!result.rows[0]) throw ApiError.notFound('Cart item not found');
  res.json({ success: true, data: result.rows[0] });
});

const removeCartItem = asyncHandler(async (req, res) => {
  const { itemId } = req.params;
  const cart = await ensureCart(req.customer.id);
  await query('DELETE FROM cart_items WHERE id = $1 AND cart_id = $2', [itemId, cart.id]);
  res.json({ success: true, message: 'Item removed' });
});

// ---------------------------------------------------------------------
// CHECKOUT — transactional: validates stock, deducts it immediately
// (via the same stock_movements ledger used by POS), creates the order,
// empties the cart, and sends a WhatsApp/SMS confirmation.
// ---------------------------------------------------------------------
const placeOrder = asyncHandler(async (req, res) => {
  const { deliveryType = 'delivery', deliveryAddress, paymentMode = 'cod', notes } = req.body;
  const customer = req.customer;

  const minOrder = await getSetting('online_store_min_order_amount', 0);
  const deliveryCharge = deliveryType === 'delivery' ? await getSetting('online_store_delivery_charge', 0) : 0;

  const order = await withTransaction(async (client) => {
    const cart = (await client.query('SELECT * FROM carts WHERE customer_id = $1', [customer.id])).rows[0];
    if (!cart) throw ApiError.badRequest('Your cart is empty');

    const items = (await client.query(
      `SELECT ci.product_id, ci.quantity, p.name, p.sale_price, p.gst_rate, p.tax_inclusive
       FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_id = $1`,
      [cart.id]
    )).rows;
    if (items.length === 0) throw ApiError.badRequest('Your cart is empty');

    // Default store: single-store Phase 1 setup (first active store).
    const store = (await client.query('SELECT id FROM stores WHERE is_active = true ORDER BY id LIMIT 1')).rows[0];
    if (!store) throw ApiError.badRequest('No active store configured');

    let subtotal = 0;
    let gstTotal = 0;
    const lineItems = [];

    for (const item of items) {
      const stockRow = (await client.query(
        `SELECT COALESCE(SUM(current_qty),0) AS qty FROM stock WHERE store_id = $1 AND product_id = $2`,
        [store.id, item.product_id]
      )).rows[0];
      if (Number(stockRow.qty) < Number(item.quantity)) {
        throw ApiError.conflict(`${item.name} only has ${stockRow.qty} in stock (you requested ${item.quantity})`);
      }

      const lineTotal = Number(item.quantity) * Number(item.sale_price);
      const taxable = item.tax_inclusive ? lineTotal / (1 + Number(item.gst_rate) / 100) : lineTotal;
      const gst = item.tax_inclusive ? lineTotal - taxable : lineTotal * (Number(item.gst_rate) / 100);
      subtotal += taxable;
      gstTotal += gst;
      lineItems.push({ ...item, taxable, total: item.tax_inclusive ? lineTotal : lineTotal + gst });

      // Deduct stock immediately via the ledger (same pattern as POS).
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, movement_type, qty_out, cost_rate, reference_type, notes, created_by)
         VALUES ($1,$2,'sale',$3,NULL,'online_order',$4,NULL)`,
        [store.id, item.product_id, item.quantity, `Online order by customer #${customer.id}`]
      );
      await client.query(
        `UPDATE stock SET current_qty = current_qty - $1 WHERE store_id = $2 AND product_id = $3`,
        [item.quantity, store.id, item.product_id]
      );
    }

    const total = subtotal + gstTotal + Number(deliveryCharge);
    if (total < Number(minOrder)) {
      throw ApiError.badRequest(`Minimum order amount is Rs.${minOrder}`);
    }

    const orderNumber = `ONL-${Date.now()}`;
    const orderResult = await client.query(
      `INSERT INTO online_orders
         (order_number, store_id, customer_id, delivery_type, delivery_address, payment_mode,
          subtotal, gst_amount, delivery_charge, total_amount, customer_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [orderNumber, store.id, customer.id, deliveryType, deliveryAddress ? JSON.stringify(deliveryAddress) : null,
        paymentMode, subtotal, gstTotal, deliveryCharge, total, notes || null]
    );
    const newOrder = orderResult.rows[0];

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO online_order_items (order_id, product_id, quantity, rate, gst_rate, taxable_amount, total_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newOrder.id, li.product_id, li.quantity, li.sale_price, li.gst_rate, li.taxable, li.total]
      );
    }
    await client.query(
      `INSERT INTO order_status_history (order_id, status, notes) VALUES ($1,'pending','Order placed by customer')`,
      [newOrder.id]
    );
    await client.query('DELETE FROM cart_items WHERE cart_id = $1', [cart.id]);

    return newOrder;
  });

  // Fire-and-forget style confirmation — order is already committed even
  // if the message fails to send (logged either way by the service).
  const shopName = await getSetting('online_store_name', 'our store');
  notificationService.sendTemplatedMessage({
    channel: 'sms',
    to: customer.mobile,
    templateCode: 'order_confirmed',
    variables: {
      name: customer.name, orderNumber: order.order_number, amount: order.total_amount,
      deliveryType: order.delivery_type, trackingUrl: `${await getSetting('online_store_url', '')}/orders/${order.id}`,
    },
    partyType: 'customer', partyId: customer.id,
  }).catch(() => {}); // notification failure must never fail the order response

  res.status(201).json({ success: true, data: order });
});

const myOrders = asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM online_orders WHERE customer_id = $1 ORDER BY created_at DESC',
    [req.customer.id]
  );
  res.json({ success: true, data: rows });
});

const myOrderDetail = asyncHandler(async (req, res) => {
  const order = (await query(
    'SELECT * FROM online_orders WHERE id = $1 AND customer_id = $2', [req.params.id, req.customer.id]
  )).rows[0];
  if (!order) throw ApiError.notFound('Order not found');
  const items = (await query(
    `SELECT oi.*, p.name FROM online_order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`,
    [order.id]
  )).rows;
  const history = (await query(
    'SELECT status, notes, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at', [order.id]
  )).rows;
  res.json({ success: true, data: { ...order, items, history } });
});

module.exports = {
  listCatalog, getCatalogItem, requestOtp, verifyOtp,
  getCart, addToCart, updateCartItem, removeCartItem,
  placeOrder, myOrders, myOrderDetail,
};
