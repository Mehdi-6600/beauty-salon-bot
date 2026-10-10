-- ============================================================================
-- Hyper Sina (هایپر سینا) — inventory adjustments (write-off / counted gain)
-- Needed so that "sold or otherwise written off" is the only way stock leaves
-- inventory value, and so a physical count can be reconciled without faking a
-- sale or an expense.
-- ============================================================================

CREATE TABLE inventory_adjustments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_date       TEXT NOT NULL,
  jperiod        TEXT NOT NULL,
  jyear          TEXT NOT NULL,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- signed: negative = write-off/shortage, positive = counted surplus
  delta_qty_x1000 INTEGER NOT NULL CHECK (delta_qty_x1000 <> 0),
  unit_cost_rial INTEGER NOT NULL CHECK (unit_cost_rial >= 0),
  -- P&L impact: positive = cost recognised (write-off), negative = recovery
  cost_impact_rial INTEGER NOT NULL,
  reason         TEXT NOT NULL DEFAULT 'shrinkage' CHECK (reason IN
                   ('shrinkage','damage','expiry','theft','count_surplus','revaluation','other')),
  note           TEXT,
  dedupe_key     TEXT UNIQUE,
  created_at     TEXT NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_adj_date ON inventory_adjustments(txn_date, id);
CREATE INDEX idx_adj_product ON inventory_adjustments(product_id);
