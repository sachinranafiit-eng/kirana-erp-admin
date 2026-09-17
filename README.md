# Kirana ERP + POS

A complete, self-hosted multi-user ERP/POS system for Indian
Kirana/Grocery retail. It includes inventory, purchasing, POS billing,
GST-ready invoices and reports, expenses, customer/supplier ledgers,
imports, multi-store controls, communications, and an online-store API.
The repo also includes a responsive React operations console for owners,
managers, inventory users, accountants, and cashiers.

- Authentication (JWT access + refresh tokens, bcrypt password hashing)
- Role-based access control with a full, editable permission matrix
- Super Admin / Admin / Manager / Accountant / Cashier / Inventory Manager /
  Purchase User / Sales User / Viewer roles, seeded with sensible defaults
- User activity logs + login logs
- Product (Item) Master with barcode assignment, system-barcode generation,
  cost/MRP/sale/wholesale price separation, and permission-gated cost/profit
  visibility
- Categories, Brands, Units masters
- Customers and Suppliers masters with running ledger endpoints
- Full audit trail (`audit_logs`) on every write
- Complete ERP workflows: stock ledger and FEFO batches, weighted-average
  purchasing, sales/returns, held bills, payments and credit limits,
  purchase orders, transfers and adjustments, expenses, GST/HSN reports,
  CSV/XLSX/PDF/GSTR-2B imports, backup export, and operational dashboards
- **WhatsApp + SMS Communications**: pluggable providers (WhatsApp Cloud
  API + MSG91 SMS), DB-editable message templates, ad-hoc send,
  automatic payment reminders computed from live customer ledger,
  opt-out-respecting marketing broadcasts, and a full send/delivery log
- **Online Store**: OTP-based customer login (SMS), a public catalog API
  reading the same product/stock data as POS, cart, and transactional
  checkout that deducts real stock through the same ledger POS uses —
  plus staff-side order lifecycle management (pending → confirmed →
  packed → shipped → delivered) with automatic customer notifications
  at each status change

The backend defaults to an embedded PGlite database for a zero-setup local
run and can use PostgreSQL in production by setting `DB_DRIVER=postgres`.
See `docs/ARCHITECTURE.md` for the system design and deployment notes.

---

## 1. Quick start (embedded database)

- Node.js 18+

```bash
# install both workspaces
npm install --prefix backend
npm install --prefix frontend

# start the API (creates local data, migrations, and a one-time owner setup code)
npm start
```

Open `http://localhost:4000`. Enter the one-time setup code printed by the
server, create the owner account, and then use the dashboard. The frontend
can be served by Vite during development with `npm --prefix frontend run dev`
or built with `npm --prefix frontend run build`.

## 2. PostgreSQL setup (production)

Set `DB_DRIVER=postgres`, `DATABASE_URL` (or the individual `DB_*` fields),
and strong JWT/session secrets in `backend/.env`, then run:

```bash
npm install --prefix backend
npm --prefix backend run migrate
npm start
```

### Third-party accounts needed for Communications/Online Store to actually send messages
- **WhatsApp**: a Meta WhatsApp Business Account + a phone number
  registered on the Cloud API, then set `WHATSAPP_PHONE_NUMBER_ID` and
  `WHATSAPP_ACCESS_TOKEN` in `.env`.
- **SMS**: an MSG91 account with a **DLT-registered sender ID**
  (mandatory in India for commercial SMS), then set `MSG91_AUTH_KEY`
  and `MSG91_SENDER_ID` in `.env`.
- Until these are configured, the API will return a clear `502` error
  naming the missing env var rather than silently pretending to send —
  the app doesn't stub or fake provider calls.

The API listens on `http://localhost:4000` by default. Health check:
`GET /health`.

## 3. Login

```bash
curl -X POST http://localhost:4000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin@123"}'
```
Returns `accessToken` (15 min) and `refreshToken` (7 days). Send the
access token as `Authorization: Bearer <token>` on all other requests.

**Change the seeded admin password immediately** via
`POST /api/v1/auth/change-password`.

## 4. API overview

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/refresh`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/change-password` |
| Users | `GET/POST /users`, `GET/PUT /users/:id`, `POST /users/:id/reset-password`, `POST /users/:id/deactivate` |
| Roles & Permissions | `GET/POST /roles`, `GET /roles/permissions/all`, `GET /roles/permissions/matrix`, `PUT /roles/:roleId/permissions` |
| Categories | `GET/POST /categories`, `PUT/DELETE /categories/:id` |
| Brands | `GET/POST /brands`, `PUT/DELETE /brands/:id` |
| Units | `GET/POST /units`, `DELETE /units/:id` |
| Products | `GET/POST /products`, `GET/PUT /products/:id`, `GET /products/barcode/:code`, `POST /products/:id/barcodes`, `POST /products/:id/deactivate` |
| Customers | `GET/POST /customers`, `GET/PUT /customers/:id`, `GET /customers/:id/ledger` |
| Suppliers | `GET/POST /suppliers`, `GET/PUT /suppliers/:id`, `GET /suppliers/:id/ledger` |
| Logs | `GET /logs/activity`, `GET /logs/logins` (admin only) |
| Notifications (staff) | `GET/POST /notifications/templates`, `PUT /notifications/templates/:id`, `POST /notifications/send`, `POST /notifications/payment-reminder`, `POST /notifications/broadcast`, `GET /notifications/logs` |
| ERP operations | `GET /erp/context`, `GET /erp/dashboard`, quotes, sales, purchases, held bills, stock, batches, movements, adjustments, transfers, purchase orders, expenses, ledger, payments, reports, settings, stores, activity |
| Imports & backup | `POST /imports/products/preview`, `POST /imports/products/commit`, `POST /imports/gstr2b/preview`, `GET /erp/backup` (owner only) |
| Online Orders (staff) | `GET /online-orders`, `GET /online-orders/:id`, `PUT /online-orders/:id/status`, `GET/PUT /online-orders/settings`, `PUT /online-orders/products/:productId/visibility` |
| Storefront (public/customer) | `GET /storefront/products`, `GET /storefront/products/:id`, `POST /storefront/auth/request-otp`, `POST /storefront/auth/verify-otp`, then (customer-token) `GET/POST /storefront/cart`, `PUT/DELETE /storefront/cart/items/:itemId`, `POST /storefront/orders`, `GET /storefront/orders`, `GET /storefront/orders/:id` |

All staff routes except `/auth/login` and `/auth/refresh` require a
staff bearer token. Storefront cart/order routes require a **separate**
customer bearer token from `/storefront/auth/verify-otp` — staff and
customer tokens are signed with different secrets and are never
interchangeable. Most staff routes additionally require a specific
permission code (e.g. `products.edit`, `online_store.manage`) — see
`database/seed.sql` and `database/002_communications_and_store_seed.sql`
for the full seeded matrix, and `PUT /roles/:roleId/permissions` to
change it at runtime.

### Example: customer places an online order
```bash
# 1. Request OTP
curl -X POST http://localhost:4000/api/v1/storefront/auth/request-otp \
  -H "Content-Type: application/json" -d '{"mobile":"9876543210"}'

# 2. Verify OTP (received via SMS) -> get a customer token
curl -X POST http://localhost:4000/api/v1/storefront/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"mobile":"9876543210","otp":"123456","name":"Rahul Sharma"}'

# 3. Add to cart & checkout (use the token from step 2)
curl -X POST http://localhost:4000/api/v1/storefront/cart/items \
  -H "Authorization: Bearer <customerToken>" -H "Content-Type: application/json" \
  -d '{"productId": 1, "quantity": 2}'

curl -X POST http://localhost:4000/api/v1/storefront/orders \
  -H "Authorization: Bearer <customerToken>" -H "Content-Type: application/json" \
  -d '{"deliveryType":"delivery","paymentMode":"cod","deliveryAddress":{"line1":"123 MG Road","city":"Dehradun","pincode":"248001"}}'
```
A product only appears in the storefront catalog once an admin sets
`is_online_visible = true` for it — via
`PUT /online-orders/products/:productId/visibility`.

### Example: create a product with opening stock
```json
POST /api/v1/products
{
  "sku": "RICE-BASMATI-1KG",
  "name": "Basmati Rice 1kg",
  "unitId": 5,
  "categoryId": 1,
  "hsnCode": "1006",
  "gstRate": 5,
  "costPrice": 90,
  "mrp": 120,
  "salePrice": 115,
  "reorderLevel": 10,
  "openingStock": 50,
  "storeId": 1,
  "barcode": ""      // leave blank to auto-generate a system barcode
}
```

## 5. Design notes worth knowing before extending this

- **Stock is never written directly.** Every quantity change goes
  through `stock_movements` (an append-only ledger); `stock.current_qty`
  is the maintained aggregate. Phase 2's purchase/adjustment endpoints
  must follow this same pattern.
- **Money fields are `NUMERIC`, never `FLOAT`**, to avoid GST rounding
  errors.
- **Cost price and profit are permission-gated** at the controller level
  (`pricing.view_cost_price`, `pricing.view_profit`) — don't leak them
  in new endpoints without the same masking.
- **Multi-store ready**: `products`, `stock`, `sales`, `purchases`, etc.
  all carry (or reference) `store_id` even though Phase 1 seeds a single
  store, so Phase 8 (multi-branch) doesn't require a schema rewrite.
- **Every write should call `logActivity`/`logAudit`** (see
  `src/utils/audit.js`) so the Admin Panel's activity log stays complete.
- **Notification providers are swappable.** All messaging goes through
  `src/services/notification.service.js` — never call
  `providers/whatsapp.provider.js` or `providers/sms.provider.js`
  directly from a controller, so the provider can be swapped later
  without touching business logic.
- **A message send never throws to the caller** (it returns
  `{status: 'sent'|'failed'}` and always logs to `notifications_log`),
  so a bad phone number or a provider outage can't fail the business
  operation that triggered it (an order, a reminder run, a broadcast).
- **Storefront checkout uses the exact same stock ledger as POS** — do
  not add a separate "online stock" number; if Phase 2/3 POS code adds
  its own stock deduction path later, make sure both paths keep writing
  to `stock_movements` the same way.

## 6. Production integrations and optional follow-ups

The ERP workflows and operations console are implemented. These external
integrations are intentionally configuration-dependent:

- An online **payment gateway** (Razorpay/PayU/UPI) — orders are
  currently cash-on-delivery only; `payment_status` exists in the
  schema ready for this.
- The customer-facing storefront UI — the API is complete and can be
  connected to a separate storefront application.
- WhatsApp **approved message templates** registered with Meta for
  messages sent outside the 24h customer window (see architecture
  doc §19) — required for reliable proactive WhatsApp delivery.

