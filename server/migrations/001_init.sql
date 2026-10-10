-- ============================================================================
-- Hyper Sina (هایپر سینا) — initial schema
-- Money is ALWAYS an integer number of rial (1 toman = 10 rial).
-- Quantities are integer thousandths (*_x1000). Rates/percent ×100.
-- ============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- auth -----
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','staff','readonly')),
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  csrf       TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ------------------------------------------------------------ settings -----
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ------------------------------------------- USD rate & inflation history --
-- One row per recorded calendar date: updating today's rate can never
-- overwrite the record of an earlier date (effective_date is UNIQUE).
CREATE TABLE fx_rates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_date   TEXT NOT NULL UNIQUE CHECK (length(effective_date) = 10),
  rate_toman_x100  INTEGER NOT NULL CHECK (rate_toman_x100 > 0),
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import')),
  note             TEXT,
  created_at       TEXT NOT NULL,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TEXT,
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_fx_dates ON fx_rates(effective_date DESC);

CREATE TABLE inflation_assumptions (
  period        TEXT PRIMARY KEY CHECK (length(period) = 7), -- Jalali YYYY-MM
  rate_pct_x100 INTEGER NOT NULL,                            -- monthly inflation, user entered
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  CHECK (rate_pct_x100 >= -10000 AND rate_pct_x100 <= 1000000)
);

-- ------------------------------------------------- accounts (صندوق/بانک) --
CREATE TABLE accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE,
  type                TEXT NOT NULL CHECK (type IN ('cash','bank')),
  opening_balance_rial INTEGER NOT NULL DEFAULT 0 CHECK (abs(opening_balance_rial) < 9000000000000000),
  is_default          INTEGER NOT NULL DEFAULT 0,
  archived            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE TABLE products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  sku            TEXT,
  kind           TEXT NOT NULL DEFAULT 'goods' CHECK (kind IN ('goods','service')),
  unit           TEXT NOT NULL DEFAULT 'عدد',
  -- running stock cache (authoritative figures are re-derived by replay in reports)
  stock_qty_x1000 INTEGER NOT NULL DEFAULT 0,
  stock_cost_rial INTEGER NOT NULL DEFAULT 0,
  last_avg_cost_rial INTEGER NOT NULL DEFAULT 0,
  replacement_unit_cost_rial   INTEGER,      -- owner-entered estimated replacement cost
  replacement_cost_at          TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  note           TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_products_sku ON products(sku) WHERE sku IS NOT NULL AND sku <> '';

CREATE TABLE customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  phone      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  phone      TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);

-- -------------------------------------------------------------- sales ------
CREATE TABLE sales (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at       TEXT NOT NULL,            -- 'YYYY-MM-DDTHH:MM' shop-local
  txn_date          TEXT NOT NULL,            -- 'YYYY-MM-DD'
  jperiod           TEXT NOT NULL,            -- Jalali 'YYYY-MM'
  jyear             TEXT NOT NULL,            -- Jalali 'YYYY'
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name      TEXT,                    -- free-text fallback (walk-in customer)
  payment_method    TEXT NOT NULL CHECK (payment_method IN ('cash','card','transfer','credit','other')),
  account_id        INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  amount_received_rial INTEGER NOT NULL DEFAULT 0 CHECK (amount_received_rial >= 0),
  header_discount_rial INTEGER NOT NULL DEFAULT 0 CHECK (header_discount_rial >= 0),
  note              TEXT,
  dedupe_key        TEXT UNIQUE,
  created_at        TEXT NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TEXT,
  updated_by        INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_sales_date ON sales(txn_date, id);
CREATE INDEX idx_sales_period ON sales(jperiod, id);
CREATE INDEX idx_sales_year ON sales(jyear, id);
CREATE INDEX idx_sales_customer ON sales(customer_id);

-- kind 'sale' adds revenue, 'return' subtracts it (positive qty on a return row).
CREATE TABLE sale_lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('sale','return')),
  qty_x1000     INTEGER NOT NULL CHECK (qty_x1000 > 0),
  unit_price_rial INTEGER NOT NULL CHECK (unit_price_rial >= 0),
  line_total_rial INTEGER NOT NULL CHECK (line_total_rial >= 0),
  discount_rial INTEGER NOT NULL DEFAULT 0 CHECK (discount_rial >= 0),
  cogs_rial     INTEGER NOT NULL DEFAULT 0,
  origin_line_id INTEGER REFERENCES sale_lines(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines(product_id, kind);

-- ---------------------------------------------------------- purchases ------
CREATE TABLE purchases (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_date   TEXT NOT NULL,
  jperiod         TEXT NOT NULL,
  jyear           TEXT NOT NULL,
  supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  supplier_name   TEXT,
  extra_cost_rial INTEGER NOT NULL DEFAULT 0 CHECK (extra_cost_rial >= 0),
  extra_cost_note TEXT,
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('cash','card','transfer','credit','other')),
  account_id      INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  amount_paid_rial INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_rial >= 0),
  note            TEXT,
  dedupe_key      TEXT UNIQUE,
  created_at      TEXT NOT NULL,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TEXT,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_purchases_date ON purchases(purchase_date, id);
CREATE INDEX idx_purchases_period ON purchases(jperiod, id);
CREATE INDEX idx_purchases_year ON purchases(jyear, id);

CREATE TABLE purchase_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id    INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty_x1000      INTEGER NOT NULL CHECK (qty_x1000 > 0),
  unit_cost_rial INTEGER NOT NULL CHECK (unit_cost_rial >= 0),
  line_total_rial INTEGER NOT NULL CHECK (line_total_rial >= 0),
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_purchase_lines_purchase ON purchase_lines(purchase_id);
CREATE INDEX idx_purchase_lines_product ON purchase_lines(product_id);

-- ------------------------------------------------------- operating expenses -
CREATE TABLE expenses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date   TEXT NOT NULL,
  jperiod        TEXT NOT NULL,
  jyear          TEXT NOT NULL,
  category       TEXT NOT NULL CHECK (category IN
                   ('rent','salaries','utilities','telecom','transport','taxes','repairs',
                    'packaging','bank_fees','other')),
  amount_rial    INTEGER NOT NULL CHECK (amount_rial > 0 AND amount_rial < 9000000000000000),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','card','transfer','credit','other')),
  account_id     INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  note           TEXT,
  dedupe_key     TEXT UNIQUE,
  created_at     TEXT NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TEXT,
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_expenses_date ON expenses(expense_date, id);
CREATE INDEX idx_expenses_period ON expenses(jperiod, category);
CREATE INDEX idx_expenses_year ON expenses(jyear, category);

-- --------------------------------------- owner capital (NOT revenue) -------
CREATE TABLE capital_txns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_date     TEXT NOT NULL,
  jperiod      TEXT NOT NULL,
  jyear        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('deposit','withdrawal')),
  amount_rial  INTEGER NOT NULL CHECK (amount_rial > 0),
  payment_method TEXT NOT NULL DEFAULT 'cash',
  account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  note         TEXT,
  dedupe_key   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_capital_period ON capital_txns(jperiod, type);

-- --------------------------------------------------- loans (NOT expense) ----
CREATE TABLE loans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_date     TEXT NOT NULL,
  jperiod      TEXT NOT NULL,
  jyear        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('loan_in','loan_repayment','loan_interest')),
  amount_rial  INTEGER NOT NULL CHECK (amount_rial > 0),
  counterparty TEXT,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  note         TEXT,
  dedupe_key   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_loans_period ON loans(jperiod, type);

-- ------------------------- settlements: paying down / collecting balances ---
CREATE TABLE settlements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_date     TEXT NOT NULL,
  jperiod      TEXT NOT NULL,
  jyear        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('customer_receipt','supplier_payment')),
  customer_id  INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  supplier_id  INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
  sale_id      INTEGER REFERENCES sales(id) ON DELETE CASCADE,
  purchase_id  INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
  amount_rial  INTEGER NOT NULL CHECK (amount_rial > 0),
  payment_method TEXT NOT NULL DEFAULT 'cash',
  account_id   INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  note         TEXT,
  dedupe_key   TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((type = 'customer_receipt' AND (customer_id IS NOT NULL OR sale_id IS NOT NULL) AND supplier_id IS NULL AND purchase_id IS NULL)
      OR (type = 'supplier_payment' AND (supplier_id IS NOT NULL OR purchase_id IS NOT NULL) AND customer_id IS NULL AND sale_id IS NULL))
);
CREATE INDEX idx_settlements_period ON settlements(jperiod, type);
CREATE INDEX idx_settlements_sale ON settlements(sale_id);
CREATE INDEX idx_settlements_purchase ON settlements(purchase_id);

-- --------------------------------------------- audit trail ------------------
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX idx_audit_time ON audit_log(created_at DESC);

-- ------------------------------------------- report snapshots ---------------
-- A snapshot freezes everything that was known when it was finalised: the
-- computed figures, the FX record used, the inflation assumption, version.
-- Later rate updates never rewrite an already-saved snapshot.
CREATE TABLE report_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type       TEXT NOT NULL CHECK (period_type IN ('month','year')),
  period            TEXT NOT NULL,            -- '1405-02' or '1405'
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('draft','final','restated')),
  payload_json      TEXT NOT NULL,
  fx_start_date     TEXT,
  fx_end_date       TEXT,
  fx_rate_end_id    INTEGER REFERENCES fx_rates(id) ON DELETE SET NULL,
  fx_rate_start_id  INTEGER REFERENCES fx_rates(id) ON DELETE SET NULL,
  inflation_base_period TEXT,
  calc_warnings_json TEXT,
  computed_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note              TEXT,
  UNIQUE (period_type, period, version)
);
CREATE INDEX idx_snapshots_lookup ON report_snapshots(period_type, period, status);

-- Corrections requested after a snapshot was finalised (explicit, audited).
CREATE TABLE report_corrections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER REFERENCES report_snapshots(id) ON DELETE SET NULL,
  period_type TEXT NOT NULL,
  period      TEXT NOT NULL,
  reason      TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  diff_json   TEXT
);

-- ------------------------------------------------- derived helpers ----------
-- Outstanding customer balance per sale (before settlements recompute).
CREATE VIEW v_sale_balances AS
SELECT s.id AS sale_id,
       s.txn_date,
       s.jperiod,
       s.customer_id,
       s.customer_name,
       (SELECT COALESCE(SUM(CASE WHEN l.kind = 'return' THEN -1 ELSE 1 END * (l.line_total_rial - l.discount_rial)), 0)
          FROM sale_lines l WHERE l.sale_id = s.id) - s.header_discount_rial AS total_rial,
       s.amount_received_rial
  FROM sales s;

CREATE VIEW v_inventory AS
SELECT p.id AS product_id,
       p.name,
       p.sku,
       p.kind,
       p.unit,
       p.stock_qty_x1000,
       p.stock_cost_rial,
       CASE WHEN p.stock_qty_x1000 > 0 THEN CAST(p.stock_cost_rial AS REAL) * 1000 / p.stock_qty_x1000 ELSE p.last_avg_cost_rial END AS avg_unit_cost_rial,
       p.replacement_unit_cost_rial,
       p.replacement_cost_at
  FROM products p;
