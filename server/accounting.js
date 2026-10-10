/**
 * Hyper Sina — accounting engine. Single source of truth for every figure.
 *
 * ── Method ─────────────────────────────────────────────────────────────────
 * `buildLedger` walks every financial event ever recorded, in date order, and
 * maintains running state for:
 *   • inventory per product (weighted-average cost)
 *   • cash / bank account balances
 *   • customer receivables (per sale) and supplier payables (per purchase)
 * Each event is accumulated into its bucket (a Jalali month, or one bucket for
 * a custom date range). Period figures are therefore *derived from the ledger*
 * rather than cached, so correcting an old transaction re-derives every later
 * figure consistently, month buckets sum exactly into the year bucket, and a
 * month with no activity is still reportable (opening = closing).
 *
 * ── Accounting identities ──────────────────────────────────────────────────
 *   Net Sales        = Gross Sales − Discounts − Returns
 *   COGS             = weighted-average cost of the units actually sold
 *   Gross Profit     = Net Sales − COGS
 *   Operating Profit = Gross Profit − Operating Expenses − Inventory write-offs
 *   Net Profit       = Operating Profit − loan interest / penalties
 * Unsold purchases stay in inventory value (never an expense). Owner deposits
 * and withdrawals move cash and equity only. Loan principal moves cash and debt
 * only. P&L and the cash view read the same events but apply different rules,
 * so nothing is double counted.
 *
 * ── Arithmetic ─────────────────────────────────────────────────────────────
 * Amounts are whole rial integers (1 toman = 10 rial). Additions are exact;
 * every division is BigInt round-half-up (per-line totals, weighted-average
 * COGS, extra-cost allocation, percentage margins, inflation deflators).
 */

import { divRound, mulDiv, sumInt } from './money.js';
import { gregorianToJalali, jalaliRange, jalaliMonthShift } from './calendar.js';

export const EXPENSE_CATEGORIES = [
  { key: 'rent', label: 'اجاره' },
  { key: 'salaries', label: 'حقوق و دستمزد' },
  { key: 'utilities', label: 'آب، برق و گاز' },
  { key: 'telecom', label: 'اینترنت و تلفن' },
  { key: 'transport', label: 'حمل و نقل و توزیع' },
  { key: 'taxes', label: 'مالیات و عوارض' },
  { key: 'repairs', label: 'تعمیرات و نگهداری' },
  { key: 'packaging', label: 'بسته‌بندی' },
  { key: 'bank_fees', label: 'کارمزد بانکی و پرداخت' },
  { key: 'other', label: 'سایر هزینه‌ها' },
];
export const EXPENSE_LABELS = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.key, c.label]));
export const ADJ_REASON_LABELS = {
  shrinkage: 'کسری موجودی',
  damage: 'آسیب‌دیدگی',
  expiry: 'انقضا',
  theft: 'سرقت',
  count_surplus: 'اضافه انبار (شمارش)',
  revaluation: 'تعدیل بهای تمام‌شده',
  other: 'سایر',
};
export const PAYMENT_METHODS = [
  { key: 'cash', label: 'نقدی' },
  { key: 'card', label: 'کارت' },
  { key: 'transfer', label: 'انتقال بانکی' },
  { key: 'credit', label: 'اعتباری (نسیه)' },
  { key: 'other', label: 'سایر' },
];
export const PAYMENT_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.key, m.label]));
export const CUSTOM_RANGE_KEY = '__custom_range__';

const INDEX_SCALE = 1_000_000n; // scaling factor for inflation index arithmetic

/** qty (thousandths) × unit price (rial) → whole rial, one round-half-up. */
export const lineTotalRial = (qtyX1000, unitRial) => Number(mulDiv(qtyX1000, unitRial, 1000));

/**
 * Allocate a purchase's additional acquisition cost (transport, insurance, …)
 * across its lines in proportion to line value. The rounding remainder goes to
 * the largest line, so allocated shares always sum exactly to the extra cost.
 */
export function allocateExtraCost(lines, extraRial) {
  const shares = new Map();
  for (const l of lines) shares.set(l.id, 0);
  const total = sumInt(lines.map((l) => l.line_total_rial));
  if (!extraRial || total <= 0) return shares;
  let allocated = 0;
  let best = lines[0];
  for (const l of lines) {
    if (l.line_total_rial > best.line_total_rial) best = l;
    const share = Number(divRound(BigInt(l.line_total_rial) * BigInt(extraRial), BigInt(total)));
    shares.set(l.id, share);
    allocated += share;
  }
  shares.set(best.id, shares.get(best.id) + (extraRial - allocated));
  return shares;
}

const EVENT_PRIORITY = { opening: -1, purchase: 0, sale: 1, adjustment: 2, expense: 3, settlement: 4, capital: 5, loan: 6 };

function cmpEvent(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const p = (EVENT_PRIORITY[a.type] ?? 9) - (EVENT_PRIORITY[b.type] ?? 9);
  if (p !== 0) return p;
  return a.id - b.id;
}

const pctOf = (part, whole) => (whole ? Number(mulDiv(part, 10000, Math.abs(whole))) : null);

function emptySnapshot() {
  return {
    inventory: new Map(),
    inventoryValue: 0,
    cash: new Map(),
    cashTotal: 0,
    receivables: 0,
    advances: 0,
    payables: 0,
  };
}

function emptyBucket(key) {
  const byCat = {};
  for (const c of EXPENSE_CATEGORIES) byCat[c.key] = 0;
  return {
    key,
    synthetic: false,
    fromDate: null,
    toDate: null,
    sales: { invoices: 0, gross: 0, lineDiscounts: 0, headerDiscounts: 0, returns: 0, net: 0, cogs: 0 },
    purchases: { invoices: 0, goodsCost: 0, extraCost: 0, qtyX1000: 0 },
    expenses: { total: 0, byCat },
    adjustments: { cost: 0, count: 0 },
    financial: { loanInterest: 0, unpaidExpense: 0 },
    cash: { inflow: 0, outflow: 0, net: 0 },
    capital: { deposits: 0, withdrawals: 0 },
    loans: { borrowed: 0, repaid: 0 },
    settlements: { received: 0, paid: 0 },
    profit: null,
    opening: emptySnapshot(),
    closing: emptySnapshot(),
    gaps: [],
    sold: new Map(), // productId → {qty, cogs, revenue, replacementCogs}
  };
}

/* ============================================================ the scan ==== */

export function buildLedger(db, options = {}) {
  const { from = null, to = null, bucketOf = null } = options;
  const scanTo = to || '9999-12-31';

  const products = new Map();
  for (const p of db.all('SELECT * FROM products')) products.set(p.id, p);
  const accounts = db.all('SELECT * FROM accounts WHERE archived = 0 ORDER BY id');

  const purchases = db.all('SELECT * FROM purchases WHERE purchase_date <= ? ORDER BY purchase_date, id', [scanTo]);
  const purchaseLines = db.all(
    `SELECT pl.*, p.purchase_date AS d FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id
      WHERE p.purchase_date <= ? ORDER BY pl.purchase_id, pl.line_total_rial DESC, pl.id`,
    [scanTo],
  );
  const sales = db.all('SELECT * FROM sales WHERE txn_date <= ? ORDER BY txn_date, id', [scanTo]);
  const saleLines = db.all(
    `SELECT l.*, s.txn_date AS d, o.cogs_rial AS origin_cogs_rial, o.qty_x1000 AS origin_qty_x1000
       FROM sale_lines l
       JOIN sales s ON s.id = l.sale_id
       LEFT JOIN sale_lines o ON o.id = l.origin_line_id
      WHERE s.txn_date <= ? ORDER BY l.sale_id, l.id`,
    [scanTo],
  );
  const expenses = db.all('SELECT * FROM expenses WHERE expense_date <= ? ORDER BY expense_date, id', [scanTo]);
  const adjustments = db.all('SELECT * FROM inventory_adjustments WHERE txn_date <= ? ORDER BY txn_date, id', [scanTo]);
  const capital = db.all('SELECT * FROM capital_txns WHERE txn_date <= ? ORDER BY txn_date, id', [scanTo]);
  const loans = db.all('SELECT * FROM loans WHERE txn_date <= ? ORDER BY txn_date, id', [scanTo]);
  const settlements = db.all('SELECT * FROM settlements WHERE txn_date <= ? ORDER BY txn_date, id', [scanTo]);
  const openingBalances = db.all('SELECT * FROM opening_balances ORDER BY id');

  const purchaseById = new Map(purchases.map((p) => [p.id, p]));
  const saleById = new Map(sales.map((s) => [s.id, s]));
  const linesByPurchase = new Map();
  for (const l of purchaseLines) {
    if (!linesByPurchase.has(l.purchase_id)) linesByPurchase.set(l.purchase_id, []);
    linesByPurchase.get(l.purchase_id).push(l);
  }
  const linesBySale = new Map();
  for (const l of saleLines) {
    if (!linesBySale.has(l.sale_id)) linesBySale.set(l.sale_id, []);
    linesBySale.get(l.sale_id).push(l);
  }
  const extraShare = new Map(); // purchase line id → allocated extra cost
  for (const p of purchases) {
    for (const [lineId, share] of allocateExtraCost(linesByPurchase.get(p.id) || [], p.extra_cost_rial)) {
      extraShare.set(lineId, share);
    }
  }

  /* ── running state ───────────────────────────────────────────────────── */
  const stock = new Map(); // productId → {qty, cost, lastUnit}
  for (const p of products.values()) stock.set(p.id, { qty: 0, cost: 0, lastUnit: 0 });
  const ensureStock = (id) => {
    if (!stock.has(id)) stock.set(id, { qty: 0, cost: 0, lastUnit: 0 });
    return stock.get(id);
  };
  const cash = new Map(); // accountId | 'unassigned' → balance
  for (const a of accounts) cash.set(a.id, a.opening_balance_rial);
  if (!accounts.length) cash.set('unassigned', 0);
  const addCash = (accountId, delta) => {
    const key = accountId ?? 'unassigned';
    cash.set(key, (cash.get(key) ?? 0) + delta);
  };
  const saleOutstanding = new Map();
  const purchaseOutstanding = new Map();
  const partyCredit = new Map(); // party name → signed adjustment (prepayments / credits)

  const openingDate = db.get(`SELECT value FROM settings WHERE key = 'opening_date'`)?.value || null;

  // Opening balances (inventory) are applied first so they precede any event
  // of the same day and never look like a purchase.
  for (const p of products.values()) {
    if (!p.opening_qty_x1000 && !p.opening_cost_rial) continue;
    const s = ensureStock(p.id);
    s.qty += p.opening_qty_x1000 || 0;
    s.cost += p.opening_cost_rial || 0;
    if (s.qty > 0) s.lastUnit = Number(mulDiv(s.cost, 1000, s.qty));
  }

  /** Opening AR/AP carried forward, net of any settlements recorded so far. */
  const carriedCache = new Map();
  function carriedAsOf(date) {
    const cacheKey = date || 'end';
    if (carriedCache.has(cacheKey)) return carriedCache.get(cacheKey);
    let ar = 0;
    let ap = 0;
    for (const ob of openingBalances) {
      const type = ob.kind === 'receivable' ? 'customer_receipt' : 'supplier_payment';
      const collected = sumInt(
        db
          .all(
            `SELECT amount_rial FROM settlements WHERE type = ? AND txn_date <= ?
              AND (customer_id IS ? OR supplier_id IS ?)`,
            [type, date || '9999-12-31', ob.party_id, ob.party_id],
          )
          .map((r) => r.amount_rial),
      );
      const net = Math.max(0, ob.amount_rial - collected);
      if (ob.kind === 'receivable') ar += net;
      else ap += net;
    }
    const out = { receivables: ar, payables: ap };
    carriedCache.set(cacheKey, out);
    return out;
  }

  const sumMap = (m, pick, field) => sumInt([...m.values()].map(pick), field);

  function snapshot(dateForCarried) {
    const inventory = new Map();
    for (const [id, s] of stock) {
      if (s.qty !== 0 || s.cost !== 0) inventory.set(id, { qty: s.qty, cost: s.cost, lastUnit: s.lastUnit });
    }
    return {
      inventory,
      inventoryValue: sumMap(stock, (s) => s.cost, 'inventory'),
      cash: new Map(cash),
      cashTotal: sumMap(cash, (v) => v, 'cash'),
      receivables: sumInt([...saleOutstanding.values()].filter((v) => v > 0), 'receivables'),
      advances: sumInt([...saleOutstanding.values()].filter((v) => v < 0).map((v) => -v), 'advances'),
      payables: sumInt([...purchaseOutstanding.values()].filter((v) => v > 0), 'payables'),
      partyCredit: new Map(partyCredit),
      carried: carriedAsOf(dateForCarried),
    };
  }

  /* ── events ──────────────────────────────────────────────────────────── */
  const events = [];
  for (const p of purchases) events.push({ type: 'purchase', date: p.purchase_date, id: p.id, row: p });
  for (const s of sales) events.push({ type: 'sale', date: s.txn_date, id: s.id, row: s });
  for (const a of adjustments) events.push({ type: 'adjustment', date: a.txn_date, id: a.id, row: a });
  for (const e of expenses) events.push({ type: 'expense', date: e.expense_date, id: e.id, row: e });
  for (const x of settlements) events.push({ type: 'settlement', date: x.txn_date, id: x.id, row: x });
  for (const c of capital) events.push({ type: 'capital', date: c.txn_date, id: c.id, row: c });
  for (const l of loans) events.push({ type: 'loan', date: l.txn_date, id: l.id, row: l });
  events.sort(cmpEvent);

  const buckets = new Map();
  const bucketOrder = [];
  const jalaliCache = new Map();
  const keyFor =
    bucketOf ||
    ((date) => {
      if (!jalaliCache.has(date)) jalaliCache.set(date, gregorianToJalali(date)?.period || null);
      return jalaliCache.get(date);
    });
  const inRange = (date) => (!from || date >= from) && (!to || date <= to);

  const getBucket = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, emptyBucket(key));
      bucketOrder.push(key);
    }
    return buckets.get(key);
  };

  let currentKey = null;
  let snapshotAtFrom = null;
  const initialSnapshot = snapshot(null);

  /** Returns the bucket to accumulate into, or null when out of range. */
  function touch(date) {
    if (!inRange(date)) return null;
    const key = keyFor(date);
    if (key === null || key === undefined) return null;
    if (snapshotAtFrom === null) snapshotAtFrom = snapshot(date);
    if (key !== currentKey) {
      if (currentKey !== null && buckets.has(currentKey)) closeBucket(buckets.get(currentKey));
      if (!buckets.has(key)) {
        const b = getBucket(key);
        b.opening = snapshot(date);
      }
      currentKey = key;
    }
    const b = buckets.get(key);
    b.toDate = date;
    return b;
  }

  function closeBucket(b) {
    if (b.closingClosed) return;
    b.closing = snapshot(b.toDate);
    b.closingClosed = true;
    finishBucket(b);
  }

  const addGap = (bucket, code, severity, message, extra) => {
    if (!bucket) return;
    const key = `${code}:${extra?.ref ?? ''}`;
    bucket.gapKeys = bucket.gapKeys || new Set();
    if (bucket.gapKeys.has(key)) return;
    bucket.gapKeys.add(key);
    bucket.gaps.push({ code, severity, message, ...extra });
  };

  for (const ev of events) {
    const bucket = touch(ev.date);
    const row = ev.row;

    if (ev.type === 'purchase') {
      const lines = linesByPurchase.get(row.id) || [];
      let goods = 0;
      for (const l of lines) {
        const s = ensureStock(l.product_id);
        s.qty += l.qty_x1000;
        const cost = (l.line_total_rial || 0) + (extraShare.get(l.id) || 0);
        s.cost += cost;
        goods += l.line_total_rial || 0;
        if (s.qty > 0) s.lastUnit = Number(mulDiv(s.cost, 1000, s.qty));
      }
      const total = goods + (row.extra_cost_rial || 0);
      const outstanding = total - (row.amount_paid_rial || 0);
      purchaseOutstanding.set(row.id, outstanding);
      if (!bucket) continue;
      bucket.purchases.invoices += 1;
      bucket.purchases.goodsCost += goods;
      bucket.purchases.extraCost += row.extra_cost_rial || 0;
      bucket.purchases.qtyX1000 += sumInt(lines.map((l) => l.qty_x1000));
      if (row.amount_paid_rial > 0) {
        bucket.cash.outflow += row.amount_paid_rial;
        addCash(row.account_id, -row.amount_paid_rial);
      }
      if (outstanding < 0) {
        addGap(bucket, 'overpaid_purchase', 'warning', 'مبلغ پرداختی برای یک خرید بیش از مبلغ فاکتور است.', { ref: row.id, amount_rial: -outstanding });
      }
      continue;
    }

    if (ev.type === 'sale') {
      const lines = linesBySale.get(row.id) || [];
      let gross = 0;
      let lineDiscounts = 0;
      let returns = 0;
      let cogs = 0;

      for (const l of lines) {
        const net = (l.line_total_rial || 0) - (l.discount_rial || 0);
        const s = ensureStock(l.product_id);
        if (l.kind === 'return') {
          returns += net;
          // a return puts the goods back at the cost they left at (origin line if linked)
          let unit = s.qty > 0 ? Number(mulDiv(s.cost, 1000, s.qty)) : s.lastUnit || 0;
          if (l.origin_cogs_rial > 0 && l.origin_qty_x1000 > 0) {
            unit = Number(mulDiv(l.origin_cogs_rial, 1000, l.origin_qty_x1000));
          }
          const restock = Number(mulDiv(l.qty_x1000, unit, 1000));
          s.qty += l.qty_x1000;
          s.cost += restock;
          if (s.qty > 0) s.lastUnit = Number(mulDiv(s.cost, 1000, s.qty));
          cogs -= restock;
          continue;
        }
        gross += l.line_total_rial || 0;
        lineDiscounts += l.discount_rial || 0;

        let lineCogs = 0;
        if (s.qty > 0) lineCogs = Math.min(s.cost, Number(divRound(BigInt(l.qty_x1000) * BigInt(s.cost), BigInt(s.qty))));
        else if (s.cost > 0) lineCogs = s.cost;
        const prod = products.get(l.product_id);
        if (s.qty <= 0 && s.cost <= 0) {
          if (prod && prod.kind === 'goods') {
            addGap(bucket, 'cogs_unknown', 'blocking', 'برای کالای فروخته‌شده هیچ بهای تمام‌شده‌ای در دسترس نبوده؛ سود ناخالص این دوره بالاتر از واقعیت است.', {
              ref: l.id,
              product: prod.name,
              amount_rial: net,
            });
          }
        }
        s.qty -= l.qty_x1000;
        s.cost -= lineCogs;
        if (lineCogs > 0) s.lastUnit = Number(mulDiv(lineCogs, 1000, l.qty_x1000));
        if (s.qty < 0) {
          addGap(bucket, 'oversold', 'blocking', 'مقدار فروش از موجودی ثبت‌شده بیشتر است؛ بهای تمام‌شدهٔ مازاد قابل استناد نیست.', {
            ref: row.id,
            product: prod?.name || 'کالا',
          });
          if (s.cost < 0) s.cost = 0;
        }
        cogs += lineCogs;
        if (bucket) {
          const prev = bucket.sold.get(l.product_id) || { qty: 0, cogs: 0, revenue: 0 };
          bucket.sold.set(l.product_id, { qty: prev.qty + l.qty_x1000, cogs: prev.cogs + lineCogs, revenue: prev.revenue + net });
        }
      }

      const total = gross - lineDiscounts - (row.header_discount_rial || 0) - returns;
      saleOutstanding.set(row.id, total - (row.amount_received_rial || 0));
      if (!bucket) continue;
      bucket.sales.invoices += 1;
      bucket.sales.gross += gross;
      bucket.sales.lineDiscounts += lineDiscounts;
      bucket.sales.headerDiscounts += row.header_discount_rial || 0;
      bucket.sales.returns += returns;
      bucket.sales.net += total;
      bucket.sales.cogs += cogs;
      if (row.amount_received_rial > 0) {
        bucket.cash.inflow += row.amount_received_rial;
        addCash(row.account_id, row.amount_received_rial);
      }
      if (total - (row.amount_received_rial || 0) < 0) {
        addGap(bucket, 'advance_from_customer', 'info', 'دریافت بیشتر از مبلغ فاکتور است؛ مازاد به‌عنوان علی‌الحساب مشتری ثبت شد.', {
          ref: row.id,
          amount_rial: (row.amount_received_rial || 0) - total,
        });
      }
      continue;
    }

    if (ev.type === 'adjustment') {
      const s = ensureStock(row.product_id);
      s.qty += row.delta_qty_x1000;
      s.cost -= row.cost_impact_rial;
      if (s.qty <= 0 && s.cost < 0) s.cost = 0;
      if (s.qty > 0) s.lastUnit = Number(mulDiv(s.cost, 1000, s.qty));
      if (!bucket) continue;
      bucket.adjustments.cost += row.cost_impact_rial;
      bucket.adjustments.count += 1;
      continue;
    }

    if (ev.type === 'expense') {
      const paid = row.amount_paid_rial === null || row.amount_paid_rial === undefined ? row.amount_rial : row.amount_paid_rial;
      const unpaid = Math.max(0, row.amount_rial - paid);
      if (paid > 0) addCash(row.account_id, -paid);
      if (!bucket) continue;
      bucket.expenses.total += row.amount_rial;
      bucket.expenses.byCat[row.category] = (bucket.expenses.byCat[row.category] || 0) + row.amount_rial;
      if (paid > 0) bucket.cash.outflow += paid;
      if (unpaid > 0) bucket.financial.unpaidExpense += unpaid;
      continue;
    }

    if (ev.type === 'settlement') {
      if (row.type === 'customer_receipt') {
        if (row.sale_id && saleOutstanding.has(row.sale_id)) saleOutstanding.set(row.sale_id, saleOutstanding.get(row.sale_id) - row.amount_rial);
        else if (row.customer_id) {
          const name = db.get('SELECT name FROM customers WHERE id = ?', [row.customer_id])?.name || 'مشتری';
          partyCredit.set(name, (partyCredit.get(name) || 0) - row.amount_rial);
        }
        if (row.amount_rial > 0) addCash(row.account_id, row.amount_rial);
        if (!bucket) continue;
        bucket.settlements.received += row.amount_rial;
        bucket.cash.inflow += row.amount_rial;
      } else {
        let remaining = row.amount_rial;
        if (row.purchase_id && purchaseOutstanding.has(row.purchase_id)) {
          const bal = purchaseOutstanding.get(row.purchase_id);
          const apply = Math.min(Math.max(bal, 0), remaining);
          purchaseOutstanding.set(row.purchase_id, bal - apply);
          remaining -= apply;
        }
        if (remaining > 0 && row.supplier_id) {
          for (const [pid, bal] of purchaseOutstanding) {
            if (remaining <= 0) break;
            const pur = purchaseById.get(pid);
            if (!pur || pur.supplier_id !== row.supplier_id || bal <= 0) continue;
            const apply = Math.min(bal, remaining);
            purchaseOutstanding.set(pid, bal - apply);
            remaining -= apply;
          }
        }
        if (remaining > 0) {
          const name =
            (row.purchase_id && purchaseById.get(row.purchase_id)?.supplier_name) ||
            (row.supplier_id && db.get('SELECT name FROM suppliers WHERE id = ?', [row.supplier_id])?.name) ||
            'تأمین‌کننده';
          partyCredit.set(name, (partyCredit.get(name) || 0) - remaining);
        }
        if (row.amount_rial > 0) addCash(row.account_id, -row.amount_rial);
        if (!bucket) continue;
        bucket.settlements.paid += row.amount_rial;
        bucket.cash.outflow += row.amount_rial;
      }
      continue;
    }

    if (ev.type === 'capital') {
      const sign = row.type === 'deposit' ? 1 : -1;
      addCash(row.account_id, sign * row.amount_rial);
      if (!bucket) continue;
      if (sign > 0) {
        bucket.capital.deposits += row.amount_rial;
        bucket.cash.inflow += row.amount_rial;
      } else {
        bucket.capital.withdrawals += row.amount_rial;
        bucket.cash.outflow += row.amount_rial;
      }
      continue;
    }

    if (ev.type === 'loan') {
      if (row.type === 'loan_in') {
        addCash(row.account_id, row.amount_rial);
        if (!bucket) continue;
        bucket.loans.borrowed += row.amount_rial;
        bucket.cash.inflow += row.amount_rial;
      } else if (row.type === 'loan_repayment') {
        addCash(row.account_id, -row.amount_rial);
        if (!bucket) continue;
        bucket.loans.repaid += row.amount_rial;
        bucket.cash.outflow += row.amount_rial;
      } else {
        addCash(row.account_id, -row.amount_rial);
        if (!bucket) continue;
        bucket.financial.loanInterest += row.amount_rial;
        bucket.cash.outflow += row.amount_rial;
      }
      continue;
    }
  }

  if (currentKey !== null && buckets.has(currentKey)) closeBucket(buckets.get(currentKey));
  const finalSnapshot = snapshot(to || null);
  if (snapshotAtFrom === null) snapshotAtFrom = initialSnapshot;

  const ledger = {
    buckets,
    bucketOrder: [...new Set(bucketOrder)].sort(),
    products,
    accounts,
    stock,
    saleOutstanding,
    purchaseOutstanding,
    partyCredit,
    sales,
    purchases,
    saleById,
    purchaseById,
    linesBySale,
    linesByPurchase,
    extraShare,
    expenses,
    adjustments,
    settlements,
    capital,
    loans,
    openingBalances,
    openingDate,
    initialSnapshot,
    snapshotAtFrom,
    finalSnapshot,
    lastEventDate: events.length ? events[events.length - 1].date : null,
    from,
    to,
  };
  return ledger;
}

function finishBucket(b) {
  const grossProfit = b.sales.net - b.sales.cogs;
  const opex = b.expenses.total + b.adjustments.cost;
  const operatingProfit = grossProfit - opex;
  const netProfit = operatingProfit - b.financial.loanInterest;
  b.profit = {
    netSales: b.sales.net,
    grossProfit,
    operatingProfit,
    netProfit,
    margins: { gross: pctOf(grossProfit, b.sales.net), operating: pctOf(operatingProfit, b.sales.net), net: pctOf(netProfit, b.sales.net) },
  };
  b.cash.net = b.cash.inflow - b.cash.outflow;
}

/**
 * Bucket for a key, synthesised from neighbouring snapshots when the period
 * contains no events at all (so empty months still report correct balances).
 */
export function bucketFor(ledger, key, { fromDate = null, toDate = null } = {}) {
  const existing = ledger.buckets.get(key);
  if (existing) return existing;
  const before = ledger.bucketOrder.filter((k) => k < key).pop();
  const after = ledger.bucketOrder.find((k) => k > key);
  const opening = before ? ledger.buckets.get(before).closing : after ? ledger.buckets.get(after).opening : ledger.snapshotAtFrom;
  const closing = after ? ledger.buckets.get(after).opening : ledger.finalSnapshot;
  const b = emptyBucket(key);
  b.synthetic = true;
  b.fromDate = fromDate ?? opening?.date ?? null;
  b.toDate = toDate ?? ledger.lastEventDate;
  b.opening = opening ?? emptySnapshot();
  b.closing = closing ?? b.opening;
  b.closingClosed = true;
  finishBucket(b);
  return b;
}

/* ========================================================== report shape == */

function choiceIdFor(db, granularity, period) {
  if (!db || !period) return null;
  const row = db.get('SELECT value FROM settings WHERE key = ?', [`fx_choice:${granularity}:${period}`]);
  return Number.isFinite(Number(row?.value)) && row ? Number(row.value) : null;
}

function partyBalances(ledger, side) {
  const map = new Map();
  const add = (name, delta, invoiceDelta) => {
    if (!name) return;
    const cur = map.get(name) || { party: name, outstanding_rial: 0, invoices: 0 };
    cur.outstanding_rial += delta;
    cur.invoices += invoiceDelta || 0;
    map.set(name, cur);
  };
  if (side === 'customer') {
    for (const [saleId, outstanding] of ledger.saleOutstanding) {
      if (outstanding === 0) continue;
      const sale = ledger.saleById.get(saleId);
      if (!sale) continue;
      add(sale.customer_name || 'مشتری بدون نام', outstanding, 1);
    }
  } else {
    for (const [pid, outstanding] of ledger.purchaseOutstanding) {
      if (outstanding === 0) continue;
      const p = ledger.purchaseById.get(pid);
      if (!p) continue;
      add(p.supplier_name || 'تأمین‌کننده بدون نام', outstanding, 1);
    }
  }
  for (const [name, delta] of ledger.partyCredit) add(name, delta, 0);
  const parties = [...map.values()].filter((p) => p.outstanding_rial !== 0).sort((a, b) => Math.abs(b.outstanding_rial) - Math.abs(a.outstanding_rial));
  const receivableSide = parties.filter((p) => p.outstanding_rial > 0);
  return {
    parties,
    total: sumInt(receivableSide.map((p) => p.outstanding_rial), 'party balances'),
    credits: sumInt(
      parties.filter((p) => p.outstanding_rial < 0).map((p) => -p.outstanding_rial),
      'party credits',
    ),
  };
}

export function publicFx(row) {
  if (!row) return null;
  return {
    id: row.id,
    effective_date: row.effective_date,
    rate_toman_x100: row.rate_toman_x100,
    note: row.note ?? null,
    source: row.source,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * `choiceId` lets the owner pin a specific saved record as the period's rate
 * (selected in «مدیریت دلار و تورم»); otherwise the latest record on or before
 * the period end is used. The choice never edits history — it only selects it.
 */
export function fxForPeriod(db, { from, to, choiceId = null }) {
  const latest = db.get('SELECT * FROM fx_rates ORDER BY effective_date DESC LIMIT 1');
  const previous = db.get('SELECT * FROM fx_rates ORDER BY effective_date DESC LIMIT 1 OFFSET 1');
  const at = (date) => (date ? db.get('SELECT * FROM fx_rates WHERE effective_date <= ? ORDER BY effective_date DESC LIMIT 1', [date]) : null);
  const start = at(from);
  const chosen = choiceId ? db.get('SELECT * FROM fx_rates WHERE id = ?', [Number(choiceId)]) : null;
  const end = chosen || at(to || '9999-12-31');
  const inPeriod =
    from && to ? db.get('SELECT COUNT(*) AS n, COALESCE(SUM(rate_toman_x100),0) AS s FROM fx_rates WHERE effective_date BETWEEN ? AND ?', [from, to]) : { n: 0, s: 0 };
  const startRate = start?.rate_toman_x100 ?? null;
  const endRate = end?.rate_toman_x100 ?? null;
  return {
    latest: publicFx(latest),
    previous: publicFx(previous),
    change_abs_x100: latest && previous ? latest.rate_toman_x100 - previous.rate_toman_x100 : null,
    change_pct_x100: latest && previous ? pctOf(latest.rate_toman_x100 - previous.rate_toman_x100, previous.rate_toman_x100) : null,
    records: db.get('SELECT COUNT(*) AS n FROM fx_rates')?.n || 0,
    period: {
      from_date: from ?? null,
      to_date: to ?? null,
      start: start ? { ...publicFx(start), exact: start.effective_date === from } : null,
      end: end ? { ...publicFx(end), exact: end.effective_date === to, manual_choice: !!chosen } : null,
      start_rate_x100: startRate,
      end_rate_x100: endRate,
      change_x100: startRate && endRate ? endRate - startRate : null,
      change_pct_x100: startRate && endRate ? pctOf(endRate - startRate, startRate) : null,
      records_in_period: inPeriod.n,
      avg_rate_x100: inPeriod.n > 0 ? Number(divRound(inPeriod.s, inPeriod.n)) : null,
      end_stale_days: end && to ? daysBetween(end.effective_date, to) : null,
    },
  };
}

export function shapeReport(ledger, bucket, { db = null, granularity = 'month', period = null, from = null, to = null } = {}) {
  const b = bucket;
  const opening = b.opening || emptySnapshot();
  const closing = b.closing || opening;
  const bounds =
    granularity === 'custom'
      ? { from: from ?? b.fromDate, to: to ?? b.toDate }
      : jalaliRange(String(b.key), granularity === 'year' ? 'year' : 'month') || { from: b.fromDate, to: b.toDate };

  const items = [];
  const ids = new Set([...opening.inventory.keys(), ...closing.inventory.keys(), ...b.sold.keys(), ...ledger.stock.keys()]);
  for (const id of ids) {
    const p = ledger.products.get(id);
    if (!p) continue;
    const op = opening.inventory.get(id) || { qty: 0, cost: 0, lastUnit: 0 };
    const cl = closing.inventory.get(id) || { qty: 0, cost: 0, lastUnit: 0 };
    const sold = b.sold.get(id) || { qty: 0, cogs: 0, revenue: 0 };
    if (!op.qty && !cl.qty && !sold.qty && !p.replacement_unit_cost_rial) continue;
    items.push({
      product_id: id,
      name: p.name,
      sku: p.sku ?? null,
      kind: p.kind,
      unit: p.unit,
      opening_qty_x1000: op.qty,
      opening_value_rial: op.cost,
      sold_qty_x1000: sold.qty,
      sold_revenue_rial: sold.revenue,
      closing_qty_x1000: cl.qty,
      closing_value_rial: cl.cost,
      avg_unit_cost_rial: cl.qty > 0 ? Number(divRound(BigInt(cl.cost) * 1000n, BigInt(cl.qty))) : cl.lastUnit || 0,
      replacement_unit_cost_rial: p.replacement_unit_cost_rial ?? null,
    });
  }
  items.sort((x, y) => y.closing_value_rial - x.closing_value_rial || String(x.name).localeCompare(String(y.name), 'fa'));

  const receivables = db ? partyBalances(ledger, 'customer') : { parties: [], total: 0, credits: 0 };
  const payables = db ? partyBalances(ledger, 'supplier') : { parties: [], total: 0, credits: 0 };
  const purchasesTotal = b.purchases.goodsCost + b.purchases.extraCost;

  const blocking = b.gaps.filter((g) => g.severity === 'blocking');
  const warnings = b.gaps.filter((g) => g.severity !== 'blocking');

  return {
    meta: {
      granularity,
      period: period ?? (granularity === 'custom' ? null : String(b.key)),
      from_date: bounds.from ?? b.fromDate,
      to_date: bounds.to ?? b.toDate,
      currency: 'IRR',
      display_unit: 'toman',
      rial_per_toman: 10,
      costing_method: 'weighted-average',
      computed_at: new Date().toISOString(),
      source: 'live',
      empty: b.sales.invoices === 0 && b.expenses.total === 0 && b.purchases.invoices === 0,
    },
    sales: {
      invoices: b.sales.invoices,
      gross_rial: b.sales.gross,
      discounts_rial: b.sales.lineDiscounts + b.sales.headerDiscounts,
      returns_rial: b.sales.returns,
      net_rial: b.sales.net,
      cogs_rial: b.sales.cogs,
    },
    profit: {
      net_sales_rial: b.profit.netSales,
      gross_rial: b.profit.grossProfit,
      operating_rial: b.profit.operatingProfit,
      net_rial: b.profit.netProfit,
      margins_pct_x100: b.profit.margins,
    },
    expenses: {
      byCategory: Object.entries(b.expenses.byCat)
        .map(([key, rial]) => ({ key, label: EXPENSE_LABELS[key], amount_rial: rial }))
        .filter((e) => e.amount_rial !== 0)
        .sort((x, y) => y.amount_rial - x.amount_rial),
      total_rial: b.expenses.total,
      inventory_adjustments_rial: b.adjustments.cost,
      loan_interest_rial: b.financial.loanInterest,
    },
    purchases: {
      invoices: b.purchases.invoices,
      goods_cost_rial: b.purchases.goodsCost,
      extra_cost_rial: b.purchases.extraCost,
      total_rial: purchasesTotal,
      qty_x1000: b.purchases.qtyX1000,
    },
    inventory: {
      items,
      opening_value_rial: opening.inventoryValue,
      closing_value_rial: closing.inventoryValue,
      movement: {
        opening_rial: opening.inventoryValue,
        purchases_rial: purchasesTotal,
        adjustments_rial: -b.adjustments.cost,
        cogs_rial: b.sales.cogs,
        closing_rial: closing.inventoryValue,
        // must be 0 — an exact reconciliation of the inventory roll-forward
        residual_rial: opening.inventoryValue + purchasesTotal - b.adjustments.cost - b.sales.cogs - closing.inventoryValue,
      },
      negative_items: [...closing.inventory.entries()]
        .filter(([, s]) => s.qty < 0)
        .map(([id, s]) => ({ product_id: id, name: ledger.products.get(id)?.name ?? '?', qty_x1000: s.qty })),
    },
    cash: {
      inflow_rial: b.cash.inflow,
      outflow_rial: b.cash.outflow,
      net_rial: b.cash.net,
      opening_rial: opening.cashTotal,
      closing_rial: closing.cashTotal,
      accounts_configured: ledger.accounts.length > 0,
      byAccount: ledger.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        opening_rial: opening.cash.get(a.id) ?? a.opening_balance_rial,
        closing_rial: closing.cash.get(a.id) ?? a.opening_balance_rial,
      })),
      unassigned_rial: closing.cash.get('unassigned') ?? 0,
    },
    receivables: {
      opening_rial: opening.receivables + (opening.carried?.receivables || 0),
      closing_rial: closing.receivables + (closing.carried?.receivables || 0),
      derived_closing_rial: closing.receivables,
      carried_opening_rial: closing.carried?.receivables || 0,
      advances_rial: closing.advances || 0,
      collected_rial: b.settlements.received,
      byParty: receivables.parties,
      credits_rial: receivables.credits,
    },
    payables: {
      opening_rial: opening.payables + (opening.carried?.payables || 0),
      closing_rial: closing.payables + (closing.carried?.payables || 0),
      derived_closing_rial: closing.payables,
      carried_opening_rial: closing.carried?.payables || 0,
      paid_rial: b.settlements.paid,
      unpaid_expenses_rial: b.financial.unpaidExpense,
      byParty: payables.parties,
      credits_rial: payables.credits,
    },
    capital: { deposits_rial: b.capital.deposits, withdrawals_rial: b.capital.withdrawals },
    loans: { borrowed_rial: b.loans.borrowed, repaid_rial: b.loans.repaid, interest_rial: b.financial.loanInterest },
    fx: db ? fxForPeriod(db, { ...bounds, choiceId: choiceIdFor(db, granularity, period ?? b.key) }) : null,
    dataGaps: { blocking, warnings, canFinalize: blocking.length === 0 },
  };
}

/* ============================================= inflation / real profit ==== */

export function loadInflation(db) {
  const map = new Map();
  for (const r of db.all('SELECT * FROM inflation_assumptions')) map.set(r.period, r);
  return map;
}

/**
 * Cumulative price index from basePeriod to targetPeriod built ONLY from the
 * owner's manually entered monthly assumptions. Each month's factor is scaled
 * by 1e6 and re-normalised, so the arithmetic stays integer-safe.
 * Returns `{factor_x1e6: null, missing: [...]}` when an assumption is missing —
 * no interpolation, no invented rate.
 */
export function inflationIndex(inflation, basePeriod, targetPeriod) {
  if (!basePeriod || !targetPeriod) return null;
  if (basePeriod === targetPeriod) return { factor_x1e6: Number(INDEX_SCALE), missing: [], used: [] };
  if (basePeriod > targetPeriod) {
    const inv = inflationIndex(inflation, targetPeriod, basePeriod);
    if (!inv) return null;
    if (inv.factor_x1e6 === null) return { factor_x1e6: null, missing: inv.missing, used: inv.used };
    return { factor_x1e6: Number(divRound(INDEX_SCALE * INDEX_SCALE, BigInt(inv.factor_x1e6))), missing: [], used: inv.used, inverted: true };
  }
  const missing = [];
  const used = [];
  let factor = INDEX_SCALE;
  let cursor = basePeriod;
  for (let guard = 0; guard < 600 && cursor < targetPeriod; guard += 1) {
    cursor = jalaliMonthShift(cursor, 1);
    const rec = inflation.get(cursor);
    if (!rec) {
      missing.push(cursor);
      continue;
    }
    // rate_pct_x100 = percent × 100 (3.5% → 350). One month's index multiplier
    // is 1 + rate, on the same 1e6 scale as INDEX_SCALE: 350 × 100 = 35 000 → 1.035.
    const monthly = INDEX_SCALE + BigInt(rec.rate_pct_x100) * 100n;
    factor = divRound(factor * monthly, INDEX_SCALE);
    used.push({ period: cursor, rate_pct_x100: rec.rate_pct_x100 });
  }
  if (missing.length) return { factor_x1e6: null, missing, used };
  return { factor_x1e6: Number(factor), missing, used };
}

/** Deflate a nominal rial figure into base-period money. */
export function deflate(nominalRial, factor_x1e6) {
  if (!factor_x1e6) return null;
  return Number(divRound(BigInt(nominalRial) * INDEX_SCALE, BigInt(factor_x1e6)));
}

export function realAnalysis(db, { period, granularity = 'month', reports = null }) {
  const inflation = loadInflation(db);
  const configuredBase = db.get(`SELECT value FROM settings WHERE key = 'inflation_base_period'`)?.value || null;
  const base = configuredBase || (granularity === 'month' ? jalaliMonthShift(period, -1) : String(Number(period) - 1));
  const target = granularity === 'month' ? period : `${period}-12`;
  const index = inflationIndex(inflation, base, target);
  const available = !!index && index.factor_x1e6 !== null;

  const nominal = reports?.current?.profit?.net_rial ?? 0;
  const real = available ? deflate(nominal, index.factor_x1e6) : null;
  const monthsInScope = [];
  if (granularity === 'month') monthsInScope.push(period);
  else for (let i = 1; i <= 12; i += 1) monthsInScope.push(`${period}-${String(i).padStart(2, '0')}`);
  const coverage = monthsInScope.map((p) => ({ period: p, rate_pct_x100: inflation.get(p)?.rate_pct_x100 ?? null }));

  const fx = fxForPeriod(db, jalaliRange(String(target), 'month') || jalaliRange(String(period), 'year') || { from: null, to: null });

  return {
    disclaimer: 'این بخش بر پایهٔ فرض تورمِ واردشده توسط شماست و نرخ رسمی تورم کشور نیست. تغییر نرخ دلار با نرخ تورم یکی نیست.',
    base_period: base,
    base_period_configured: !!configuredBase,
    available,
    cumulative_factor_x1e6: available ? index.factor_x1e6 : null,
    missing_periods: available ? [] : index?.missing || [],
    monthly_assumptions: coverage,
    nominal_profit_rial: nominal,
    real_profit_rial: real,
    profit_purchasing_power_change_pct_x100: available && nominal ? pctOf((real ?? 0) - nominal, Math.abs(nominal)) : null,
    fx_period_change_pct_x100: fx?.period?.change_pct_x100 ?? null,
    inflation_vs_fx_note: 'برای مقایسه نشان داده می‌شود: درصد تغییر نرخ دلار در دوره با درصد تورم فرضی شما دو شاخص جدا هستند.',
    cash: available
      ? {
          nominal_rial: reports?.current?.cash?.closing_rial ?? 0,
          real_rial: deflate(reports?.current?.cash?.closing_rial ?? 0, index.factor_x1e6),
        }
      : null,
    inventory: available
      ? {
          nominal_rial: reports?.current?.inventory?.closing_value_rial ?? 0,
          real_rial: deflate(reports?.current?.inventory?.closing_value_rial ?? 0, index.factor_x1e6),
        }
      : null,
  };
}

/* ================================================ replacement-cost view === */

export function replacementAnalysis(ledger, bucket) {
  const items = [];
  let replacementCogs = 0;
  let coveredRevenue = 0;
  let totalSoldRevenue = 0;
  for (const [productId, sold] of bucket.sold) {
    const p = ledger.products.get(productId);
    totalSoldRevenue += sold.revenue;
    if (!p || p.kind !== 'goods') {
      items.push({ product_id: productId, name: p?.name ?? '?', kind: p?.kind ?? 'goods', available: false, skipped: 'service' });
      continue;
    }
    const rc = p.replacement_unit_cost_rial;
    if (!rc) {
      items.push({
        product_id: productId,
        name: p.name,
        available: false,
        skipped: 'no_replacement_cost',
        sold_qty_x1000: sold.qty,
        historical_cogs_rial: sold.cogs,
        revenue_rial: sold.revenue,
      });
      continue;
    }
    const cost = Number(mulDiv(sold.qty, rc, 1000));
    replacementCogs += cost;
    coveredRevenue += sold.revenue;
    items.push({
      product_id: productId,
      name: p.name,
      available: true,
      sold_qty_x1000: sold.qty,
      historical_unit_cost_rial: sold.qty > 0 ? Number(divRound(sold.cogs, sold.qty)) : 0,
      historical_cogs_rial: sold.cogs,
      replacement_unit_cost_rial: rc,
      replacement_cogs_rial: cost,
      difference_rial: cost - sold.cogs,
      revenue_rial: sold.revenue,
      recorded_at: p.replacement_cost_at ?? null,
    });
  }
  items.sort((a, b) => (b.replacement_cogs_rial || 0) - (a.replacement_cogs_rial || 0));

  const netSales = bucket.sales.net;
  const opex = bucket.expenses.total + bucket.adjustments.cost;
  const profitReplacement = netSales - replacementCogs - opex;
  const profitHistorical = netSales - bucket.sales.cogs - opex;
  const missing = items.filter((i) => !i.available && i.skipped === 'no_replacement_cost');
  return {
    label: 'سود بر مبنای هزینهٔ جایگزینی — برآورد مدیریتی، جایگزین سود حسابداری رسمی نیست',
    available: coveredRevenue > 0,
    items,
    net_sales_rial: netSales,
    historical_cogs_rial: bucket.sales.cogs,
    replacement_cogs_rial: replacementCogs,
    profit_historical_rial: profitHistorical,
    profit_replacement_rial: profitReplacement,
    difference_rial: profitReplacement - profitHistorical,
    coverage_pct_x100: totalSoldRevenue > 0 ? pctOf(coveredRevenue, totalSoldRevenue) : null,
    missing_products: missing.map((m) => m.name),
  };
}

/* ==================================================== period accessors ==== */

export function monthReport(db, period, { to } = {}) {
  const range = jalaliRange(String(period), 'month');
  if (!range) return null;
  const ledger = buildLedger(db, { to: to && to < range.to ? to : range.to });
  const bucket = bucketFor(ledger, String(period));
  const report = shapeReport(ledger, bucket, { db, granularity: 'month', period: String(period) });
  report.period_label = formatPeriodLabel(String(period), 'month');
  report.previous_period = jalaliMonthShift(String(period), -1);
  report.year = String(period).slice(0, 4);
  return { ledger, bucket, report };
}

/** Year report — accurate aggregation of its Jalali month buckets. */
export function yearReport(db, year) {
  const range = jalaliRange(String(year), 'year');
  if (!range) return null;
  const ledger = buildLedger(db, { to: range.to });
  const months = [];
  const buckets = [];
  for (let i = 1; i <= 12; i += 1) {
    const key = `${year}-${String(i).padStart(2, '0')}`;
    const bucket = bucketFor(ledger, key);
    buckets.push(bucket);
    months.push({ key, report: shapeReport(ledger, bucket, { db: null, granularity: 'month', period: key }) });
  }
  const merged = mergeBuckets(buckets, String(year));
  const report = shapeReport(ledger, merged, { db, granularity: 'year', period: String(year) });
  report.period_label = `سال ${formatDigits(String(year))}`;
  report.months = months.map((m) => ({
    period: m.key,
    label: formatPeriodLabel(m.key, 'month'),
    net_sales_rial: m.report.sales.net_rial,
    cogs_rial: m.report.sales.cogs_rial,
    gross_profit_rial: m.report.profit.gross_rial,
    operating_profit_rial: m.report.profit.operating_rial,
    net_profit_rial: m.report.profit.net_rial,
    expenses_rial: m.report.expenses.total_rial,
    cash_net_rial: m.report.cash.net_rial,
    closing_inventory_rial: m.report.inventory.closing_value_rial,
    closing_cash_rial: m.report.cash.closing_rial,
    fx_end_rate_x100: m.report.fx?.period?.end_rate_x100 ?? null,
    fx_change_pct_x100: m.report.fx?.period?.change_pct_x100 ?? null,
    net_margin_pct_x100: m.report.profit.margins_pct_x100.net,
    blocking_gaps: m.report.dataGaps.blocking.length,
  }));
  const active = report.months.filter((m) => m.net_sales_rial !== 0 || m.expenses_rial !== 0);
  if (active.length) {
    const byProfit = [...active].sort((a, b) => b.net_profit_rial - a.net_profit_rial);
    report.best_month = byProfit[0];
    report.worst_month = byProfit[byProfit.length - 1];
  }
  return { ledger, bucket: merged, report, months };
}

export function rangeReport(db, { from, to }) {
  const ledger = buildLedger(db, {
    from,
    to,
    bucketOf: () => CUSTOM_RANGE_KEY,
  });
  const bucket = bucketFor(ledger, CUSTOM_RANGE_KEY, { fromDate: from, toDate: to });
  const report = shapeReport(ledger, bucket, { db, granularity: 'custom', period: null, from, to });
  return { ledger, bucket, report };
}

function mergeBuckets(buckets, year) {
  const merged = emptyBucket(String(year));
  for (const b of buckets) {
    merged.sales.invoices += b.sales.invoices;
    merged.sales.gross += b.sales.gross;
    merged.sales.lineDiscounts += b.sales.lineDiscounts;
    merged.sales.headerDiscounts += b.sales.headerDiscounts;
    merged.sales.returns += b.sales.returns;
    merged.sales.net += b.sales.net;
    merged.sales.cogs += b.sales.cogs;
    merged.purchases.invoices += b.purchases.invoices;
    merged.purchases.goodsCost += b.purchases.goodsCost;
    merged.purchases.extraCost += b.purchases.extraCost;
    merged.purchases.qtyX1000 += b.purchases.qtyX1000;
    merged.expenses.total += b.expenses.total;
    for (const [k, v] of Object.entries(b.expenses.byCat)) merged.expenses.byCat[k] += v;
    merged.adjustments.cost += b.adjustments.cost;
    merged.adjustments.count += b.adjustments.count;
    merged.financial.loanInterest += b.financial.loanInterest;
    merged.financial.unpaidExpense += b.financial.unpaidExpense;
    merged.cash.inflow += b.cash.inflow;
    merged.cash.outflow += b.cash.outflow;
    merged.capital.deposits += b.capital.deposits;
    merged.capital.withdrawals += b.capital.withdrawals;
    merged.loans.borrowed += b.loans.borrowed;
    merged.loans.repaid += b.loans.repaid;
    merged.settlements.received += b.settlements.received;
    merged.settlements.paid += b.settlements.paid;
    for (const [pid, v] of b.sold) {
      const prev = merged.sold.get(pid) || { qty: 0, cogs: 0, revenue: 0 };
      merged.sold.set(pid, { qty: prev.qty + v.qty, cogs: prev.cogs + v.cogs, revenue: prev.revenue + v.revenue });
    }
    for (const g of b.gaps) if (!merged.gaps.some((x) => x.code === g.code && String(x.ref) === String(g.ref))) merged.gaps.push({ ...g, period: b.key });
  }
  const first = buckets.find((b) => !b.synthetic) || buckets[0];
  const lastReal = [...buckets].reverse().find((b) => !b.synthetic) || buckets[buckets.length - 1];
  merged.opening = first?.opening || emptySnapshot();
  merged.closing = lastReal?.closing || emptySnapshot();
  merged.fromDate = buckets[0]?.fromDate || jalaliRange(String(year), 'year')?.from || null;
  merged.toDate = buckets[buckets.length - 1]?.toDate || jalaliRange(String(year), 'year')?.to || null;
  finishBucket(merged);
  return merged;
}

const formatDigits = (s) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

export function formatPeriodLabel(period, granularity = 'month') {
  if (!period) return '';
  if (granularity === 'year') return `سال ${formatDigits(period)}`;
  const [y, m] = String(period).split('-');
  return `${['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'][Number(m) - 1]} ${formatDigits(y)}`;
}

export { sumInt, divRound, mulDiv };
