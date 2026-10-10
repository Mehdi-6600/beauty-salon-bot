-- ============================================================================
-- Hyper Sina (هایپر سینا) — opening balances & partially paid expenses
--
-- • products.opening_* : optional opening inventory for shops that existed
--   before adopting the app (never a "purchase", never revenue/expense).
-- • expenses.amount_paid_rial : NULL = fully paid. Lets an expense be recorded
--   while unpaid, so profit is recognised but cash is not (no double counting).
-- • opening_balances : carried-forward customer receivable / supplier payable
--   from before the shop started using the app. Shown separately and never
--   re-derived, and reduced by later settlements.
-- ============================================================================

ALTER TABLE products ADD COLUMN opening_qty_x1000 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN opening_cost_rial INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expenses ADD COLUMN amount_paid_rial INTEGER CHECK (amount_paid_rial IS NULL OR (amount_paid_rial >= 0 AND amount_paid_rial <= amount_rial));

CREATE TABLE opening_balances (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('receivable','payable')),
  party_name    TEXT NOT NULL,
  party_id      INTEGER,
  amount_rial   INTEGER NOT NULL CHECK (amount_rial > 0),
  occurred_date TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_opening_bal_kind ON opening_balances(kind);
