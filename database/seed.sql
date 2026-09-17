-- =====================================================================
-- Seed data: roles, full permission matrix, one store, current FY,
-- and a minimal starter catalog. Run AFTER schema.sql.
-- The super_admin USER is created separately via `npm run seed:admin`
-- in /backend (it needs bcrypt to hash the password) — see README.
-- =====================================================================

INSERT INTO roles (name, description, is_system) VALUES
 ('super_admin', 'Full unrestricted access', true),
 ('admin', 'Full access, configurable', false),
 ('manager', 'Store operations management', false),
 ('accountant', 'Financial & GST reporting', false),
 ('cashier', 'POS billing only', false),
 ('inventory_manager', 'Stock & purchase management', false),
 ('purchase_user', 'Purchase entry only', false),
 ('sales_user', 'Sales entry, no cost/profit visibility', false),
 ('viewer', 'Read-only reports access', false);

-- Permission catalog: module.action
INSERT INTO permissions (module, action, code, description) VALUES
 ('products','view','products.view','View products'),
 ('products','add','products.add','Add products'),
 ('products','edit','products.edit','Edit products'),
 ('products','delete','products.delete','Delete products'),
 ('pricing','view_cost_price','pricing.view_cost_price','View cost/purchase price'),
 ('pricing','view_profit','pricing.view_profit','View profit figures'),
 ('pricing','change_selling_price','pricing.change_selling_price','Edit sale price'),
 ('sales','view','sales.view','View sales/invoices'),
 ('sales','add','sales.add','Create sale/invoice'),
 ('sales','edit','sales.edit','Edit previous invoice'),
 ('sales','cancel','sales.cancel','Cancel invoice'),
 ('sales','discount','sales.discount','Apply discount'),
 ('sales','return','sales.return','Process sales return'),
 ('sales','print','sales.print','Print / reprint invoice'),
 ('purchases','view','purchases.view','View purchases'),
 ('purchases','add','purchases.add','Enter purchase'),
 ('purchases','edit','purchases.edit','Edit purchase'),
 ('purchases','approve','purchases.approve','Approve purchase order'),
 ('inventory','view','inventory.view','View stock'),
 ('inventory','adjust','inventory.adjust','Stock adjustment'),
 ('inventory','manage','inventory.manage','Manage inventory settings'),
 ('customers','view','customers.view','View customers'),
 ('customers','manage','customers.manage','Add/edit customers'),
 ('suppliers','view','suppliers.view','View suppliers'),
 ('suppliers','manage','suppliers.manage','Add/edit suppliers'),
 ('reports','view','reports.view','View reports'),
 ('reports','export','reports.export','Export reports'),
 ('gst','manage','gst.manage','Manage GST settings/reports'),
 ('users','manage','users.manage','Manage users & roles'),
 ('settings','manage','settings.manage','Manage system settings');

-- Role → Permission matrix
-- admin: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.name = 'admin';

-- manager: everything except users.manage and settings.manage
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'manager' AND p.code NOT IN ('users.manage','settings.manage');

-- accountant: financial visibility, reports, GST, no product/user edits
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'accountant' AND p.code IN
 ('products.view','pricing.view_cost_price','pricing.view_profit','sales.view',
  'purchases.view','reports.view','reports.export','gst.manage',
  'customers.view','suppliers.view');

-- cashier: POS only, no cost/profit, limited sales rights
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'cashier' AND p.code IN
 ('products.view','sales.view','sales.add','sales.print','customers.view');

-- inventory_manager
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'inventory_manager' AND p.code IN
 ('products.view','products.add','products.edit','pricing.view_cost_price',
  'inventory.view','inventory.adjust','inventory.manage',
  'purchases.view','purchases.add','suppliers.view');

-- purchase_user
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'purchase_user' AND p.code IN
 ('products.view','purchases.view','purchases.add','suppliers.view');

-- sales_user: sales only, no cost/profit
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'sales_user' AND p.code IN
 ('products.view','sales.view','sales.add','sales.print','customers.view');

-- viewer: read-only
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'viewer' AND p.code IN
 ('products.view','sales.view','purchases.view','inventory.view',
  'reports.view','customers.view','suppliers.view');

-- Store + Financial Year
INSERT INTO stores (name, type, address, is_active)
VALUES ('Main Store', 'shop', 'Update this address from Settings', true);

INSERT INTO financial_years (code, start_date, end_date, is_current)
VALUES ('2026-27', '2026-04-01', '2027-03-31', true);

-- Starter catalog
INSERT INTO units (name, short_code) VALUES
 ('Kilogram','kg'), ('Gram','g'), ('Litre','ltr'), ('Millilitre','ml'),
 ('Piece','pcs'), ('Box','box'), ('Packet','pkt'), ('Dozen','dz');

INSERT INTO categories (name) VALUES
 ('Grocery'), ('Dairy'), ('Beverages'), ('Snacks'), ('Personal Care'),
 ('Household'), ('Staples'), ('Bakery');

INSERT INTO settings (key, value) VALUES
 ('costing_method', '"weighted_average"'),
 ('allow_negative_stock', 'false'),
 ('invoice_prefix', '"INV"'),
 ('expiry_alert_days', '[30,60,90]');
