-- =====================================================================
-- Kirana ERP + POS — PostgreSQL Schema
-- Phase 1 & 2 tables are fully used by the backend included in this repo.
-- Phase 3+ tables are included now so the ER design is complete and no
-- breaking migrations are needed later, but are not yet wired to API code.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------
-- FINANCIAL YEAR / STORE (multi-branch ready from day one)
-- ---------------------------------------------------------------------
CREATE TABLE financial_years (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(10) NOT NULL UNIQUE,   -- e.g. '2026-27'
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    is_current      BOOLEAN NOT NULL DEFAULT false,
    is_closed       BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stores (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    type            VARCHAR(20) NOT NULL DEFAULT 'shop', -- shop | godown | warehouse
    gstin           VARCHAR(15),
    address         TEXT,
    state           VARCHAR(50),
    state_code      VARCHAR(2),
    phone           VARCHAR(20),
    email           VARCHAR(150),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- IDENTITY & ACCESS
-- ---------------------------------------------------------------------
CREATE TABLE roles (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,  -- super_admin, admin, cashier, ...
    description     VARCHAR(255),
    is_system       BOOLEAN NOT NULL DEFAULT false, -- super_admin cannot be deleted/edited
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
    id              SERIAL PRIMARY KEY,
    module          VARCHAR(50) NOT NULL,   -- products, sales, purchases, reports, ...
    action          VARCHAR(50) NOT NULL,   -- view, add, edit, delete, print, export,
                                             -- approve, cancel, return, discount,
                                             -- change_selling_price, view_cost_price,
                                             -- view_profit, manage_gst, manage_users, ...
    code            VARCHAR(120) NOT NULL UNIQUE, -- '<module>.<action>'
    description     VARCHAR(255),
    UNIQUE(module, action)
);

CREATE TABLE role_permissions (
    role_id         INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   INT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    store_id        INT REFERENCES stores(id),
    role_id         INT NOT NULL REFERENCES roles(id),
    full_name       VARCHAR(150) NOT NULL,
    username        VARCHAR(50) NOT NULL UNIQUE,
    email           VARCHAR(150) UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255) NOT NULL,
    pin_hash        VARCHAR(255),         -- optional admin PIN for sensitive re-auth
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INT REFERENCES users(id),
    username_tried  VARCHAR(50),
    success         BOOLEAN NOT NULL,
    ip_address      VARCHAR(64),
    user_agent      VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_activity_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INT REFERENCES users(id),
    action          VARCHAR(100) NOT NULL,  -- 'invoice.create', 'price.change', ...
    entity_type     VARCHAR(50),
    entity_id       VARCHAR(50),
    details         JSONB,
    ip_address      VARCHAR(64),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         INT REFERENCES users(id),
    table_name      VARCHAR(64) NOT NULL,
    record_id       VARCHAR(64) NOT NULL,
    operation       VARCHAR(10) NOT NULL,   -- INSERT | UPDATE | DELETE | CANCEL
    old_data        JSONB,
    new_data        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- CATALOG
-- ---------------------------------------------------------------------
CREATE TABLE categories (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    parent_id       INT REFERENCES categories(id),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(name, parent_id)
);

CREATE TABLE brands (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL UNIQUE,
    manufacturer    VARCHAR(150),
    is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE units (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,   -- Kg, Litre, Pcs, Box...
    short_code      VARCHAR(10) NOT NULL UNIQUE    -- kg, ltr, pcs, box
);

CREATE TABLE suppliers (
    id              SERIAL PRIMARY KEY,
    company_name    VARCHAR(150) NOT NULL,
    contact_person  VARCHAR(100),
    mobile          VARCHAR(20),
    email           VARCHAR(150),
    address         TEXT,
    gstin           VARCHAR(15),
    pan             VARCHAR(10),
    state           VARCHAR(50),
    state_code      VARCHAR(2),
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit_period_days INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(150) NOT NULL,
    mobile          VARCHAR(20),
    whatsapp        VARCHAR(20),
    email           VARCHAR(150),
    address         TEXT,
    gstin           VARCHAR(15),
    state           VARCHAR(50),
    state_code      VARCHAR(2),
    customer_type   VARCHAR(20) NOT NULL DEFAULT 'retail', -- retail | wholesale
    credit_limit    NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit_days     INT NOT NULL DEFAULT 0,
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    loyalty_points  INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id                  SERIAL PRIMARY KEY,
    sku                 VARCHAR(50) NOT NULL UNIQUE,
    name                VARCHAR(200) NOT NULL,
    local_name          VARCHAR(200),
    description         TEXT,
    category_id         INT REFERENCES categories(id),
    brand_id            INT REFERENCES brands(id),
    supplier_id         INT REFERENCES suppliers(id),
    unit_id             INT NOT NULL REFERENCES units(id),
    hsn_code            VARCHAR(10),
    gst_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,   -- e.g. 5.00, 12.00, 18.00
    tax_inclusive       BOOLEAN NOT NULL DEFAULT true,
    -- pricing: always kept distinct per business rule
    cost_price          NUMERIC(12,2) NOT NULL DEFAULT 0,
    mrp                 NUMERIC(12,2) NOT NULL DEFAULT 0,
    sale_price          NUMERIC(12,2) NOT NULL DEFAULT 0,
    wholesale_price     NUMERIC(12,2),
    min_selling_price   NUMERIC(12,2),
    default_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    pack_size           VARCHAR(50),
    min_stock_level     NUMERIC(12,3) NOT NULL DEFAULT 0,
    max_stock_level     NUMERIC(12,3),
    reorder_level       NUMERIC(12,3) NOT NULL DEFAULT 0,
    rack_location       VARCHAR(50),
    product_type        VARCHAR(30) NOT NULL DEFAULT 'standard', -- standard|weighted|combo
    track_batches       BOOLEAN NOT NULL DEFAULT false,
    track_expiry        BOOLEAN NOT NULL DEFAULT false,
    image_url           VARCHAR(255),
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_by          INT REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);

CREATE TABLE product_barcodes (
    id              SERIAL PRIMARY KEY,
    product_id      INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    barcode         VARCHAR(50) NOT NULL UNIQUE,
    is_system_generated BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_batches (
    id              SERIAL PRIMARY KEY,
    product_id      INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    batch_number    VARCHAR(50),
    mfg_date        DATE,
    expiry_date     DATE,
    cost_price      NUMERIC(12,2),
    mrp             NUMERIC(12,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- INVENTORY (Phase 2)
-- ---------------------------------------------------------------------
CREATE TABLE stock (
    id              SERIAL PRIMARY KEY,
    store_id        INT NOT NULL REFERENCES stores(id),
    product_id      INT NOT NULL REFERENCES products(id),
    batch_id        INT REFERENCES product_batches(id),
    current_qty     NUMERIC(14,3) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(store_id, product_id, batch_id)
);

-- Append-only ledger — the single source of truth for every stock change.
CREATE TABLE stock_movements (
    id              BIGSERIAL PRIMARY KEY,
    store_id        INT NOT NULL REFERENCES stores(id),
    product_id      INT NOT NULL REFERENCES products(id),
    batch_id        INT REFERENCES product_batches(id),
    movement_type   VARCHAR(30) NOT NULL, -- opening|purchase|sale|sale_return|
                                           -- purchase_return|damage|expired|
                                           -- adjustment|transfer_in|transfer_out
    qty_in          NUMERIC(14,3) NOT NULL DEFAULT 0,
    qty_out         NUMERIC(14,3) NOT NULL DEFAULT 0,
    cost_rate       NUMERIC(12,2),
    reference_type  VARCHAR(30),   -- 'purchase', 'sale', 'adjustment', ...
    reference_id    VARCHAR(50),
    notes           VARCHAR(255),
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_product ON stock_movements(product_id, created_at);

-- ---------------------------------------------------------------------
-- PURCHASING (Phase 2)
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
    id              SERIAL PRIMARY KEY,
    store_id        INT NOT NULL REFERENCES stores(id),
    supplier_id     INT NOT NULL REFERENCES suppliers(id),
    po_number       VARCHAR(50) NOT NULL UNIQUE,
    status          VARCHAR(20) NOT NULL DEFAULT 'draft', -- draft|sent|received|cancelled
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchases (
    id                  SERIAL PRIMARY KEY,
    store_id            INT NOT NULL REFERENCES stores(id),
    financial_year_id   INT NOT NULL REFERENCES financial_years(id),
    supplier_id         INT NOT NULL REFERENCES suppliers(id),
    purchase_order_id   INT REFERENCES purchase_orders(id),
    invoice_number      VARCHAR(50) NOT NULL,   -- our internal number
    supplier_invoice_no VARCHAR(50),
    purchase_date       DATE NOT NULL,
    taxable_amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
    cgst_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
    payment_status      VARCHAR(20) NOT NULL DEFAULT 'unpaid', -- unpaid|partial|paid
    source              VARCHAR(20) NOT NULL DEFAULT 'manual', -- manual|excel|pdf
    created_by          INT REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(store_id, invoice_number)
);

CREATE TABLE purchase_items (
    id              SERIAL PRIMARY KEY,
    purchase_id     INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id      INT NOT NULL REFERENCES products(id),
    batch_id        INT REFERENCES product_batches(id),
    quantity        NUMERIC(14,3) NOT NULL,
    free_quantity   NUMERIC(14,3) NOT NULL DEFAULT 0,
    purchase_rate   NUMERIC(12,2) NOT NULL,
    discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
    gst_rate        NUMERIC(5,2) NOT NULL DEFAULT 0,
    taxable_amount  NUMERIC(14,2) NOT NULL,
    total_amount    NUMERIC(14,2) NOT NULL
);

CREATE TABLE purchase_returns (
    id              SERIAL PRIMARY KEY,
    purchase_id     INT NOT NULL REFERENCES purchases(id),
    product_id      INT NOT NULL REFERENCES products(id),
    quantity        NUMERIC(14,3) NOT NULL,
    reason          VARCHAR(255),
    amount          NUMERIC(14,2) NOT NULL,
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- SALES / POS (Phase 3 — schema included now for completeness)
-- ---------------------------------------------------------------------
CREATE TABLE sales (
    id                  SERIAL PRIMARY KEY,
    store_id            INT NOT NULL REFERENCES stores(id),
    financial_year_id   INT NOT NULL REFERENCES financial_years(id),
    customer_id         INT REFERENCES customers(id),
    invoice_number      VARCHAR(50) NOT NULL,
    invoice_type        VARCHAR(20) NOT NULL DEFAULT 'gst', -- gst|non_gst|quotation|estimate
    sale_type           VARCHAR(20) NOT NULL DEFAULT 'retail', -- retail|wholesale
    status              VARCHAR(20) NOT NULL DEFAULT 'completed', -- held|completed|cancelled
    subtotal            NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    cgst_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    round_off           NUMERIC(6,2) NOT NULL DEFAULT 0,
    total_amount        NUMERIC(14,2) NOT NULL DEFAULT 0,
    payment_mode        VARCHAR(20),   -- cash|upi|card|credit|wallet|bank|split
    cashier_id          INT REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(store_id, invoice_number)
);

CREATE TABLE sale_items (
    id                  SERIAL PRIMARY KEY,
    sale_id             INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id          INT NOT NULL REFERENCES products(id),
    batch_id            INT REFERENCES product_batches(id),
    quantity            NUMERIC(14,3) NOT NULL,
    rate                NUMERIC(12,2) NOT NULL,
    discount_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,
    gst_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    cost_price_snapshot NUMERIC(12,2) NOT NULL DEFAULT 0, -- for accurate historical P&L
    taxable_amount      NUMERIC(14,2) NOT NULL,
    total_amount        NUMERIC(14,2) NOT NULL
);

CREATE TABLE sales_returns (
    id              SERIAL PRIMARY KEY,
    sale_id         INT NOT NULL REFERENCES sales(id),
    product_id      INT NOT NULL REFERENCES products(id),
    quantity        NUMERIC(14,3) NOT NULL,
    reason          VARCHAR(255),
    amount          NUMERIC(14,2) NOT NULL,
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
    id              SERIAL PRIMARY KEY,
    party_type      VARCHAR(20) NOT NULL, -- customer|supplier
    party_id        INT NOT NULL,
    reference_type  VARCHAR(20),          -- sale|purchase|advance
    reference_id    INT,
    amount          NUMERIC(14,2) NOT NULL,
    mode            VARCHAR(20) NOT NULL, -- cash|upi|card|bank
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credit_notes (
    id SERIAL PRIMARY KEY, customer_id INT REFERENCES customers(id),
    sale_id INT REFERENCES sales(id), amount NUMERIC(14,2) NOT NULL,
    reason VARCHAR(255), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE debit_notes (
    id SERIAL PRIMARY KEY, supplier_id INT REFERENCES suppliers(id),
    purchase_id INT REFERENCES purchases(id), amount NUMERIC(14,2) NOT NULL,
    reason VARCHAR(255), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- EXPENSES / GST (Phase 4-5)
-- ---------------------------------------------------------------------
CREATE TABLE expenses (
    id              SERIAL PRIMARY KEY,
    store_id        INT NOT NULL REFERENCES stores(id),
    expense_date    DATE NOT NULL,
    category        VARCHAR(50) NOT NULL,
    description     VARCHAR(255),
    amount          NUMERIC(14,2) NOT NULL,
    payment_mode    VARCHAR(20),
    vendor          VARCHAR(150),
    reference       VARCHAR(100),
    attachment_url  VARCHAR(255),
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gst_transactions (
    id              BIGSERIAL PRIMARY KEY,
    transaction_type VARCHAR(10) NOT NULL,  -- sale|purchase
    reference_id    INT NOT NULL,
    hsn_code        VARCHAR(10),
    taxable_amount  NUMERIC(14,2) NOT NULL,
    cgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    gst_rate        NUMERIC(5,2) NOT NULL,
    transaction_date DATE NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- IMPORTS / SETTINGS
-- ---------------------------------------------------------------------
CREATE TABLE import_jobs (
    id              SERIAL PRIMARY KEY,
    type            VARCHAR(20) NOT NULL, -- excel|csv|pdf
    file_name       VARCHAR(255),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|preview|committed|failed
    total_rows      INT,
    error_rows      INT,
    result_summary  JSONB,
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
    key             VARCHAR(100) PRIMARY KEY,
    value           JSONB NOT NULL,
    updated_by      INT REFERENCES users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Trigger: keep users.updated_at fresh (pattern reused for other tables)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_suppliers_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- trigram index support for fast product search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
