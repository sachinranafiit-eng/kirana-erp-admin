# Kirana ERP + POS — System Architecture

Scope: Multi-user ERP/POS for Indian Kirana/Grocery retail, built for future
expansion to supermarkets, multi-branch, multi-warehouse, and multi-GSTIN.

Stack: **React (Vite) frontend · Node.js/Express backend · PostgreSQL · JWT auth**

---

## 1. Module Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLIENT LAYER                            │
│  React SPA (Admin/Back-office)   │   POS Terminal UI (touch)     │
│  Mobile-responsive views          │   Barcode camera scanner      │
└───────────────┬───────────────────────────────┬─────────────────┘
                │ REST/JSON (JWT bearer)         │
┌───────────────▼───────────────────────────────▼─────────────────┐
│                        API GATEWAY LAYER                         │
│  Express app → auth middleware → RBAC middleware → audit hook    │
└───────────────┬───────────────────────────────────────────────┘
                │
┌───────────────▼───────────────────────────────────────────────┐
│                        DOMAIN MODULES                            │
│  Auth & Users   Roles/Perms   Products    Inventory   Barcode    │
│  Purchases      Suppliers     Customers   POS/Sales   Returns    │
│  Expenses       GST           Profit&Loss Reports     Import     │
│  Settings       Stores/Branches           Audit Logs             │
└───────────────┬───────────────────────────────────────────────┘
                │ transactional SQL (pg pool, explicit transactions)
┌───────────────▼───────────────────────────────────────────────┐
│                    POSTGRESQL (per financial year partitioned    │
│                    where relevant: sales, sale_items, purchases) │
└───────────────────────────────────────────────────────────────┘
```

Each domain module = its own controller + route file + (later) service
layer, so modules can be split into microservices later without a rewrite
if the business grows to multi-branch scale.

---

## 2. Database ER Overview

Core entity groups (full DDL in `database/schema.sql`):

- **Identity & Access**: `users`, `roles`, `permissions`, `role_permissions`, `user_activity_logs`, `login_logs`
- **Org structure**: `stores` (branches/godowns), `financial_years`
- **Catalog**: `categories`, `brands`, `units`, `products`, `product_barcodes`, `product_batches`
- **Inventory**: `stock`, `stock_movements` (immutable ledger)
- **Parties**: `customers`, `suppliers`
- **Purchasing**: `purchase_orders`, `purchases`, `purchase_items`, `purchase_returns`
- **Sales**: `sales`, `sale_items`, `sales_returns`
- **Money**: `payments`, `credit_notes`, `debit_notes`, `expenses`
- **Tax**: `gst_transactions`, `hsn_codes`
- **Ops**: `audit_logs`, `settings`, `import_jobs`

Key relational rules:
- `stock_movements` is append-only — every stock change (purchase, sale,
  return, adjustment, damage) inserts a row; `stock.current_qty` is a
  maintained aggregate, never edited directly by the UI.
- `products` never store MRP/cost/sale price as a single field — these are
  three distinct columns, editable independently per permission.
- All money-moving tables carry `store_id`, `financial_year_id`, `created_by`,
  `created_at` for audit and multi-branch readiness from day one, even
  though Phase 1 runs with a single seeded store.

---

## 3. User Role & Permission Structure

Roles (seeded, editable): `super_admin`, `admin`, `manager`, `accountant`,
`cashier`, `inventory_manager`, `purchase_user`, `sales_user`, `viewer`.

Permissions are **module × action** pairs, e.g. `products.edit`,
`invoices.cancel`, `reports.export`, `pricing.view_cost`,
`pricing.view_profit`. `role_permissions` is a many-to-many join table —
this is the permission matrix. `super_admin` bypasses the check entirely
(hardcoded, not stored, so it can never be revoked by mistake).

Sensitive actions (invoice edit/cancel, stock adjustment, purchase
approval, discount above threshold) can additionally require an **Admin
PIN re-auth**, checked at the endpoint via a `requirePin` middleware.

---

## 4. Navigation / Sidebar Structure

```
Dashboard
POS
Sales        → Invoices · Quotations · Returns · Credit Notes
Purchases    → Purchase Orders · Purchase Invoices · Purchase Returns
Inventory    → Stock Ledger · Adjustments · Batches · Transfers
Products     → Item Master · Categories · Brands · Units
Customers    → Directory · Ledger · Credit
Suppliers    → Directory · Ledger · Payable
Expenses
GST          → Sales/Purchase Register · GSTR-1/2B/3B data · HSN Summary
Reports      → Sales · Stock · Purchase · Customer · GST · Profit
Users        → Roles & Permissions · Activity Logs
Barcode      → Label Design · Bulk Print
Import Data  → Excel/CSV · PDF Invoice Import
Communications → Templates · Send Message · Payment Reminders · Broadcast Campaigns · Message Log
Online Store  → Catalog Visibility · Orders · Store Settings
Settings     → Business · Billing · Inventory · Users
Admin Panel  (super_admin/admin only — full dashboard above)
```

## 5. Dashboard Wireframe (text form)

Row 1 (KPI cards): Today's Sales | Today's Purchase | Gross Profit | Net Profit
Row 2 (KPI cards): Cash/UPI/Card/Credit split | Receivable | Payable | Stock Value
Row 3: Low Stock table | Expiring Products table
Row 4: Sales Trend (line chart, 30d) | Category-wise Sales (pie/bar)
Row 5: Best Sellers table | Slow Movers table | Cashier-wise Sales table

## 6. POS Screen Design

Left (70%): product grid/search + barcode input (auto-focus), cart list
(qty editable inline, per-line discount).
Right (30%): customer selector, bill summary (subtotal, discount, GST,
round-off, total), payment mode buttons, Hold/Recall/Pay buttons.
Top bar: Hold Bill, Recall Bill, New Sale, Cashier name, Shift info.
All primary actions keyboard-mapped (F2 search, F4 hold, F9 pay, etc.).

## 7. Product Master Design
Tabbed form: **General** (name, category, brand, unit, barcode) ·
**Pricing** (cost/purchase price, MRP, sale price, wholesale price, tax
inclusive toggle) · **Stock** (opening stock, min/max/reorder levels,
batch & expiry tracking toggle) · **Tax** (HSN/SAC, GST rate) ·
**Media** (image). Cost price and profit-relevant fields hidden from
roles without `pricing.view_cost` / `pricing.view_profit`.

## 8. Purchase Workflow
Purchase Order (optional) → Goods Receipt → Purchase Invoice entry
(manual, Excel, or PDF-extracted) → line-item review/edit → on save:
DB transaction inserts `purchases`+`purchase_items`, writes one
`stock_movements` row per line (`type='purchase'`), updates `stock`
aggregate, updates supplier ledger/payable — all inside one SQL
transaction so partial saves are impossible.

## 9. Stock Workflow
Every event (purchase, sale, sales return, purchase return, damage,
expiry write-off, transfer, manual adjustment) → one `stock_movements`
row with `qty_in`/`qty_out`, `reference_type`, `reference_id`,
`created_by`. `stock.current_qty` is recalculated by a DB trigger (or a
service-layer function inside the same transaction) — never written
directly by a controller.

## 10. GST Workflow
Every sale/purchase line writes a `gst_transactions` row (taxable value,
CGST/SGST/IGST split by intra/inter-state, HSN). Reports (GSTR-1 data,
GSTR-2B reconciliation, GSTR-3B summary) are read-only aggregations over
this table — no direct government API filing in Phase 1 (per your note,
only added if an authorized GSP integration is provided).

## 11. Profit & Loss Logic
```
COGS (per line) = qty_sold × cost_price_at_time_of_sale   (FIFO or
                   weighted-average per Settings.costing_method)
Gross Profit     = Sale Value (excl. GST) − COGS
Net Profit       = Gross Profit − Expenses (period)
```
`sale_items` stores `cost_price_snapshot` at sale time so historical
P&L never shifts when current cost price changes later.

## 12. Report List
See your doc §18 — implemented as parameterized SQL views/queries with a
shared filter contract (`date_range, store_id, category_id, product_id,
customer_id, supplier_id, user_id, payment_mode`) so every report shares
one filter UI component.

## 13. PDF Import Workflow
Upload → text/table extraction (OCR fallback for scanned PDFs) → field
mapping to `{supplier, invoice_no, date, line_items[]}` → fuzzy-match
each line to existing `products` (by barcode → SKU → name similarity) →
present editable preview → user corrects/confirms → same transactional
purchase-save path as manual entry. Unmatched lines flagged
`"New Item – Create Product"`.

## 14. Barcode Workflow
Scanner/camera → keyboard-wedge or `getUserMedia` + decode library →
lookup by `product_barcodes.code` → add to cart (qty++ on repeat scan
within a short window) or, in Product Master, auto-fill the barcode
field. System-generated barcodes use `EAN-13` with an internal prefix
range reserved so they never collide with manufacturer codes.

## 15. API Architecture
REST, versioned under `/api/v1`. Resource-oriented routes per module
(see backend). Auth via short-lived JWT access token + refresh token.
Every mutating endpoint wrapped in a DB transaction where it touches
more than one table (sales, purchases, stock adjustments).

## 16. Folder / Project Structure
```
kirana-erp/
├── docs/ARCHITECTURE.md
├── database/schema.sql, seed.sql, 002_communications_and_store_{schema,seed}.sql
├── backend/
│   └── src/{config,providers,services,middleware,utils,controllers,routes,server.js,app.js}
└── frontend/            (Phase 3+: React app — POS + back-office)
    └── storefront/      (Phase 10: customer-facing online store site)
```

## 19. WhatsApp & SMS Communications Module

Purpose: invoice sharing, payment reminders, low-stock alerts, and
promotional broadcasts — the "Marg/Vyapar-style" messaging layer.

- **Providers are abstracted** behind `providers/whatsapp.provider.js`
  (Meta WhatsApp Cloud API) and `providers/sms.provider.js` (MSG91,
  the common India transactional/promotional SMS gateway). Swapping to
  Twilio/Kaleyra/Gupshup means replacing one file — the rest of the app
  only calls `notificationService.sendTemplatedMessage(...)`.
- **Templates live in the database** (`notification_templates`), not in
  code, so an Admin can edit wording without a deploy. Seeded templates:
  invoice link, payment reminder, low-stock alert, order confirmed,
  order status update, OTP login, generic promo broadcast.
- **Every send is logged** to `notifications_log` (channel, recipient,
  status, provider response) for a message history / delivery audit.
- **Consent is respected**: `customers.opt_in_marketing` is checked on
  every broadcast; a customer who has opted out never receives
  promotional (as opposed to transactional) messages.
- **WhatsApp's 24-hour window rule**: Meta only allows free-form text
  within 24h of the customer's last message; anything outside that
  (proactive order updates, reminders) technically requires an
  *approved WhatsApp template* registered with Meta — the provider file
  includes both `sendWhatsAppText` and `sendWhatsAppTemplate` for this
  reason. In practice, many shops route reminders/promos over SMS and
  reserve WhatsApp for replies within an active conversation, or get
  their transactional templates pre-approved by Meta.
- **India SMS compliance**: commercial SMS requires a DLT
  (Distributed Ledger Technology) registered sender ID and template
  with the telecom regulator (TRAI) — this is an MSG91 account-level
  setup step, not something the app can bypass.

## 20. Online Store (E-commerce) Module

Purpose: let customers browse the same catalog and place orders online
— for pickup or delivery — without a second, disconnected system.

- **One customer record, two channels.** The `customers` table used by
  POS is the same table storefront customers log into (matched by
  mobile number), so purchase history, loyalty points, and outstanding
  balance are unified whether a sale happened in-shop or online.
- **OTP login, not passwords.** `POST /storefront/auth/request-otp` →
  SMS OTP → `POST /storefront/auth/verify-otp` → a customer-scoped JWT
  (separate secret/namespace from staff tokens, so a leaked customer
  token can never touch admin endpoints).
- **Per-product online visibility.** `products.is_online_visible` lets
  a shop sell an item in-store without listing it online (e.g. loose/
  weighed items not yet photographed), plus separate `online_description`
  and `online_images` fields from the internal Item Master description.
- **Stock is shared, not duplicated.** The storefront reads the same
  `stock` aggregate POS uses, and checkout deducts it through the same
  `stock_movements` ledger (`movement_type='sale'`,
  `reference_type='online_order'`) — so an item that sells out in the
  shop instantly shows as unavailable online, and vice versa.
- **Orders are their own entity** (`online_orders` /
  `online_order_items`), not shoehorned into the POS `sales` table,
  because online orders have a lifecycle POS sales don't: pending →
  confirmed → packed → shipped → delivered (or cancelled/returned),
  tracked in `order_status_history`. Each status change can
  auto-notify the customer via the Communications module.
- **Checkout is transactional**: stock availability is re-checked and
  deducted inside one DB transaction per order, so two customers can
  never both "successfully" order the last unit.
- **Store settings** (enabled/disabled, delivery charge, minimum order
  amount, banner text, public URL) are simple key/value rows in the
  existing `settings` table — no new settings table needed.
- **Not yet included** (natural next additions): online payment
  gateway integration (Razorpay/PayU/UPI intent for prepaid orders —
  currently COD/pay-on-delivery only), a public storefront *frontend*
  (this phase ships the API only), delivery-partner/logistics
  integration, and product reviews/ratings.

## 17. Security Design
- bcrypt password hashing (cost 12), JWT access (15 min) + refresh (7d, rotated).
- RBAC middleware checks `role_permissions` on every route.
- Admin-PIN re-auth on sensitive actions (invoice edit/cancel, stock adjust).
- All inputs validated server-side (express-validator); parameterized SQL only.
- `audit_logs` + `login_logs` capture who/what/when for every write and login attempt.
- Rate limiting on `/auth/login` to slow brute force.

## 18. Backup Strategy
- Nightly `pg_dump` to local + off-site storage, retained 30 days rolling
  + monthly archives retained 12 months.
- Manual "Backup Now" button in Admin Panel (triggers same script).
- Restore tooling documented in README; restore always to a *new* DB
  first for verification before swapping.

---

## Phase Plan (as specified, + Communications/Online Store)
1. Auth, Admin Panel, Roles/Permissions, Product Master, Category/Brand/Unit, Customer, Supplier — **built**
2. Inventory, Purchase, Stock Ledger, Barcode
3. POS Billing, Sales, Returns, Printing
4. Expenses, Profit & Loss, Ledgers
5. GST Reports
6. Bulk/PDF Import
7. Advanced Reports & Analytics
8. Multi-store, backups, mobile optimization
9. WhatsApp & SMS Communications (templates, ad-hoc send, payment reminders, broadcasts) — **built**
10. Online Store (OTP customer login, catalog, cart, checkout with live stock, order lifecycle) — **built**

Phase 9 & 10 were built ahead of 2–8 because they were requested next;
they intentionally reuse Phase 1's `products`/`customers`/`stock` tables
so nothing here needs to be redone once Phases 2–8 are built.
