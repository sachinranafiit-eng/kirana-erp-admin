-- =====================================================================
-- Seed for Migration 002 — run after 002_communications_and_store_schema.sql
-- =====================================================================

INSERT INTO permissions (module, action, code, description) VALUES
 ('notifications','send','notifications.send','Send WhatsApp/SMS to a customer or supplier'),
 ('notifications','manage','notifications.manage','Manage message templates and broadcast campaigns'),
 ('online_store','view','online_store.view','View online orders'),
 ('online_store','manage','online_store.manage','Manage online store settings, catalog visibility and order status');

-- admin gets everything automatically already (role_permissions inserted
-- by CROSS JOIN in 001 only covered permissions that existed then), so
-- grant these four explicitly to admin and manager:
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'admin'
  AND p.code IN ('notifications.send','notifications.manage','online_store.view','online_store.manage');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'manager'
  AND p.code IN ('notifications.send','online_store.view','online_store.manage');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'accountant' AND p.code = 'notifications.send'; -- for payment reminders

-- Starter message templates — {{placeholders}} are filled at send time.
INSERT INTO notification_templates (code, channel, name, body_template, variables) VALUES
 ('invoice_link', 'both', 'Invoice Shared',
  'Hi {{name}}, thank you for shopping at {{shopName}}! Your bill of Rs.{{amount}} (Invoice #{{invoiceNumber}}) is ready: {{invoiceUrl}}',
  '["name","shopName","amount","invoiceNumber","invoiceUrl"]'),
 ('payment_reminder', 'both', 'Payment Reminder',
  'Hi {{name}}, this is a reminder that Rs.{{outstanding}} is due at {{shopName}}. Please pay at your earliest convenience. Thank you.',
  '["name","shopName","outstanding"]'),
 ('low_stock_alert', 'whatsapp', 'Low Stock Alert (internal)',
  'Stock alert: {{productName}} is low ({{currentQty}} {{unit}} left, reorder level {{reorderLevel}}).',
  '["productName","currentQty","unit","reorderLevel"]'),
 ('order_confirmed', 'both', 'Online Order Confirmed',
  'Hi {{name}}, your order #{{orderNumber}} of Rs.{{amount}} has been confirmed and will be {{deliveryType}} soon. Track: {{trackingUrl}}',
  '["name","orderNumber","amount","deliveryType","trackingUrl"]'),
 ('order_status_update', 'both', 'Online Order Status Update',
  'Hi {{name}}, your order #{{orderNumber}} is now {{status}}. {{extraNote}}',
  '["name","orderNumber","status","extraNote"]'),
 ('otp_login', 'sms', 'Storefront Login OTP',
  'Your OTP to login at {{shopName}} online store is {{otp}}. Valid for 5 minutes. Do not share this with anyone.',
  '["shopName","otp"]'),
 ('promo_broadcast', 'whatsapp', 'Promotional Broadcast (generic)',
  'Hi {{name}}, {{offerText}} Visit us or order online: {{storeUrl}}',
  '["name","offerText","storeUrl"]');

-- Default online store settings (reuses the generic `settings` table)
INSERT INTO settings (key, value) VALUES
 ('online_store_enabled', 'false'),
 ('online_store_name', '"My Kirana Store"'),
 ('online_store_delivery_charge', '0'),
 ('online_store_min_order_amount', '0'),
 ('online_store_banner_text', '""'),
 ('whatsapp_provider', '"whatsapp_cloud_api"'),
 ('sms_provider', '"msg91"');
