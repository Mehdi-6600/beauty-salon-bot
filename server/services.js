/**
 * Hyper Sina — write services.
 *
 * Every mutation of financial data goes through this file, which guarantees:
 *  • server-side validation (units, ranges, cross-field consistency)
 *  • decimal-safe totals computed here, never trusted from the client
 *  • duplicate protection through `dedupe_key` (unique index) — a double-tapped
 *    save button returns 409 instead of writing a second ledger row
 *  • an audit trail (before/after) for every create/update/delete
 *  • inventory running totals re-derived from the ledger after each write
 */

import {
  buildLedger,
  lineTotalRial,
  monthReport,
  yearReport,
  rangeReport,
  realAnalysis,
  replacementAnalysis,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  allocateExtraCost,
} from './accounting.js';
import { badRequest, conflict, notFound, amountField, V } from './http.js';
import { parseQtyX1000, parsePctX100, sumInt, divRound, mulDiv } from './money.js';
import { gregorianToJalali } from './calendar.js';

const nowIso = () => new Date().toISOString();
const CATEGORIES = EXPENSE_CATEGORIES.map((c) => c.key);
const METHODS = PAYMENT_METHODS.map((m) => m.key);

function jp(date) {
  const j = gregorianToJalali(date);
  if (!j) throw badRequest('تاریخ واردشده معتبر نیست.');
  return { jperiod: j.period, jyear: j.year };
}

export function audit(db, { userId = null, entity, entityId = null, action, before = null, after = null, note = null }) {
  db.run('INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json, note, created_at) VALUES (?,?,?,?,?,?,?,?)', [
    userId,
    entity,
    entityId === null ? null : String(entityId),
    action,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    note,
    nowIso(),
  ]);
}

function insert(db, table, data) {
  const keys = Object.keys(data);
  const info = db.run(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((k) => data[k]));
  return info.lastInsertRowid;
}

function uniqueViolation(err) {
  const msg = String(err?.message || '');
  return /UNIQUE constraint failed/i.test(msg);
}

function withDedupe(db, table, data, dedupeKey, label) {
  if (dedupeKey) data.dedupe_key = dedupeKey;
  try {
    return insert(db, table, data);
  } catch (err) {
    if (uniqueViolation(err) && dedupeKey) {
      const existing = db.get(`SELECT id FROM ${table} WHERE dedupe_key = ?`, [dedupeKey]);
      throw conflict('این تراکنش پیش‌تر ثبت شده است (جلوگیری از ثبت تکراری).', { existing_id: existing?.id ?? null, label });
    }
    throw err;
  }
}

/** Re-derive the cached stock figures from the ledger (single source of truth). */
export function refreshStockCache(db) {
  const { stock, products } = buildLedger(db);
  for (const [id, s] of stock) {
    if (!products.has(id)) continue;
    db.run('UPDATE products SET stock_qty_x1000 = ?, stock_cost_rial = ?, last_avg_cost_rial = ? WHERE id = ?', [
      s.qty,
      s.cost,
      avgUnitCostRial(s.cost, s.qty, s.lastUnit),
      id,
    ]);
  }
}

/* --------------------------------------------------------------- helpers -- */

function ensureDefaultAccount(db) {
  const existing =
    db.get('SELECT id FROM accounts WHERE is_default = 1 AND archived = 0 ORDER BY id LIMIT 1') ||
    db.get('SELECT id FROM accounts WHERE archived = 0 ORDER BY id LIMIT 1');
  if (existing) return existing.id;
  const id = insert(db, 'accounts', {
    name: 'صندوق',
    type: 'cash',
    opening_balance_rial: 0,
    is_default: 1,
    created_at: nowIso(),
  });
  audit(db, { userId: null, entity: 'account', entityId: id, action: 'auto-create', after: { name: 'صندوق', reason: 'تنظیم خودکار حساب پیش‌فرض برای ثبت نقدی' } });
  return id;
}

/**
 * Payment accounts are resolved server-side (never trusted from the client).
 * `allowNone` is used for transactions that move no money (e.g. a credit sale
 * with nothing received yet), which must not touch any cash balance.
 */
function resolveAccount(db, { paymentMethod, accountId, allowNone = false, label = 'حساب/صندوق' }) {
  if (accountId) {
    const a = db.get('SELECT id, name, archived FROM accounts WHERE id = ?', [Number(accountId)]);
    if (!a) throw badRequest(`حساب انتخابی (${label}) وجود ندارد.`, { field: 'account_id' });
    if (a.archived) throw badRequest(`حساب «${a.name}» بایگانی شده است.`, { field: 'account_id' });
    return a.id;
  }
  if (allowNone) return null;
  return ensureDefaultAccount(db);
}

function qtyField(value, label) {
  const q = parseQtyX1000(value, { allowNegative: false });
  if (q === null || q <= 0) throw badRequest(`تعداد/مقدار «${label}» باید عددی بزرگ‌تر از صفر (حداکثر ۳ رقم اعشار) باشد.`, { field: 'qty' });
  return q;
}

/* ---------------------------------------------------------------- sales --- */

function normalizeSaleLines(db, lines, { forUpdate = false, saleId = null } = {}) {
  if (!Array.isArray(lines) || !lines.length) throw badRequest('حداقل یک ردیف کالا/خدمت برای ثبت فاکتور لازم است.', { field: 'lines' });
  if (lines.length > 60) throw badRequest('حداکثر ۶۰ ردیف در یک فاکتور مجاز است.', { field: 'lines' });
  const out = [];
  for (const [idx, raw] of lines.entries()) {
    const kind = raw.kind === 'return' ? 'return' : 'sale';
    const label = `ردیف ${idx + 1}`;
    let productId = raw.product_id ? Number(raw.product_id) : null;
    if (!productId && raw.new_product && String(raw.new_product.name || '').trim()) {
      const p = ensureProduct(db, {
        name: String(raw.new_product.name).trim(),
        sku: raw.new_product.sku || null,
        kind: raw.new_product.kind === 'service' ? 'service' : 'goods',
        unit: raw.new_product.unit || 'عدد',
      });
      productId = p.id;
    }
    if (!productId) {
      // last resort: match by name text typed by the owner (quick entry)
      const name = String(raw.description || '').trim();
      const found = name ? db.get('SELECT id FROM products WHERE name = ? COLLATE NOCASE', [name]) : null;
      if (found) productId = found.id;
    }
    if (!productId) throw badRequest(`برای «${label}» کالا یا خدمت را انتخاب کنید (یا آن را بسازید).`, { field: `lines[${idx}].product_id` });
    const product = db.get('SELECT id, name, kind FROM products WHERE id = ?', [productId]);
    if (!product) throw badRequest(`کالای ردیف ${idx + 1} وجود ندارد.`, { field: `lines[${idx}].product_id` });

    const qty = qtyField(raw.qty_x1000 ?? raw.qty, label);
    const unitRial = amountField(raw, { tomanField: 'unit_price_toman', rialField: 'unit_price_rial', required: true, min: 0, label: `قیمت واحد ${label}` });
    const discount = amountField(raw, { tomanField: 'discount_toman', rialField: 'discount_rial', required: false, min: 0, label: `تخفیف ${label}` }) ?? 0;
    const lineTotal = lineTotalRial(qty, unitRial || 0);
    if (discount > lineTotal) throw badRequest(`تخفیف «${label}» نمی‌تواند بیشتر از مبلغ کل آن ردیف باشد.`, { field: `lines[${idx}].discount_toman` });
    let originLineId = null;
    if (kind === 'return') {
      originLineId = Number(raw.origin_line_id) || null;
      if (!originLineId) throw badRequest('برای ثبت مرجوعی، ردیف اصلی فروش باید مشخص شود.', { field: `lines[${idx}].origin_line_id` });
      const origin = db.get('SELECT * FROM sale_lines WHERE id = ?', [originLineId]);
      if (!origin) throw badRequest('ردیف مرجوع‌شده پیدا نشد.', { field: `lines[${idx}].origin_line_id` });
      if (origin.product_id !== product.id) throw badRequest('کالای مرجوعی با کالای ردیف اصلی یکی نیست.', { field: `lines[${idx}].origin_line_id` });
      // Everything already returned against that line — on other invoices, and
      // earlier in this very payload — counts toward the cap. While an invoice is
      // being edited, its own return lines are being resubmitted, so they are
      // excluded here and picked up by `returnedHere` instead.
      const alreadyReturned = sumInt(
        db
          .all('SELECT qty_x1000 AS q FROM sale_lines WHERE origin_line_id = ? AND kind = ? AND sale_id != ?', [
            originLineId,
            'return',
            saleId ?? 0,
          ])
          .map((r) => r.q),
      );
      const returnedHere = out.filter((x) => x.kind === 'return' && x.origin_line_id === originLineId).reduce((a, x) => a + x.qty_x1000, 0);
      if (qty + alreadyReturned + returnedHere > origin.qty_x1000) {
        throw badRequest('مقدار مرجوعی بیشتر از مقدار فروخته‌شدهٔ همان ردیف است.', { field: `lines[${idx}].qty` });
      }
    }
    out.push({
      // Only meaningful while editing: lets updateSale keep a line's identity
      // instead of replacing it (return records point at these ids).
      id: raw.id ? Number(raw.id) : null,
      kind,
      product_id: product.id,
      description: String(raw.description || product.name).slice(0, 200),
      qty_x1000: qty,
      unit_price_rial: unitRial || 0,
      line_total_rial: lineTotal,
      discount_rial: discount,
      origin_line_id: originLineId,
      // snapshot of what the weighted-average cost was at recording time (audit
      // trail only — reports re-derive COGS from the ledger)
      cogs_rial: 0,
    });
  }
  return out;
}

function ensureProduct(db, { name, sku = null, kind = 'goods', unit = 'عدد' }) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!clean) throw badRequest('نام کالا/خدمت الزامی است.', { field: 'name' });
  const existing = db.get('SELECT * FROM products WHERE name = ? COLLATE NOCASE', [clean]);
  if (existing) {
    if (sku && !existing.sku) db.run('UPDATE products SET sku = ? WHERE id = ?', [String(sku).slice(0, 60), existing.id]);
    return existing;
  }
  const id = insert(db, 'products', {
    name: clean,
    sku: sku ? String(sku).slice(0, 60) : null,
    kind: kind === 'service' ? 'service' : 'goods',
    unit: String(unit || 'عدد').slice(0, 20),
    created_at: nowIso(),
  });
  return db.get('SELECT * FROM products WHERE id = ?', [id]);
}

/**
 * An invoice may never receive more than its own total. Extra money from a
 * customer belongs to the party-level advances (POST /api/settlements without a
 * sale_id), so invoice arithmetic stays reconcilable with the receipts list.
 */
function assertInvoiceReceipt({ received, settled = 0, total }) {
  if (received + settled > total) {
    throw badRequest(
      settled > 0
        ? 'مبلغ دریافتی (همراه با وصول‌های قبلی) از کل فاکتور بیشتر است. ابتدا وصول‌ها را اصلاح کنید.'
        : 'مبلغ دریافتی از کل فاکتور بیشتر است. برای ثبت علی‌الحساب، وصول را جدا و بدون انتخاب فاکتور ثبت کنید.',
      { field: 'received_toman' },
    );
  }
}

export function saleTotals(lines, headerDiscount = 0) {
  const gross = sumInt(lines.filter((l) => l.kind === 'sale').map((l) => l.line_total_rial));
  const lineDiscounts = sumInt(lines.map((l) => l.discount_rial));
  const returns = sumInt(lines.filter((l) => l.kind === 'return').map((l) => l.line_total_rial - l.discount_rial));
  const total = gross - lineDiscounts - headerDiscount - returns;
  if (total < 0) throw badRequest('مجموع فاکتور نمی‌تواند منفی شود (تخفیف/مرجوعی بیشتر از مبلغ فروش است).', { field: 'discount_toman' });
  return { gross, lineDiscounts, returns, total };
}

export function createSale(db, actor, body) {
  const date = V.date('date', { label: 'تاریخ فروش', future: 'reject' })(body);
  const time = V.time('time')(body) || nowIso().slice(11, 16);
  const paymentMethod = V.oneOf('payment_method', METHODS, { required: true, label: 'روش پرداخت' })(body);
  const customerName = V.text('customer_name', { maxLength: 120, label: 'نام مشتری' })(body);
  const note = V.text('note', { maxLength: 1000, label: 'یادداشت' })(body);
  const dedupeKey = V.uuid()(body);
  const { jperiod, jyear } = jp(date);

  return db.tx(() => {
    const lines = normalizeSaleLines(db, body.lines);
    const headerDiscount = amountField(body, { tomanField: 'discount_toman', rialField: 'discount_rial', required: false, min: 0, label: 'تخفیف کل فاکتور' }) ?? 0;
    const totals = saleTotals(lines, headerDiscount);
    const received = amountField(body, { tomanField: 'received_toman', rialField: 'received_rial', required: false, min: 0, label: 'مبلغ دریافتی' }) ?? 0;
    assertInvoiceReceipt({ received, total: totals.total });
    // money actually received posts to an account; the unpaid remainder is a
    // receivable, so it never inflates cash.
    const accountId = received > 0 ? resolveAccount(db, { paymentMethod, accountId: body.account_id, label: 'واریز به' }) : null;

    const saleId = withDedupe(
      db,
      'sales',
      {
        occurred_at: `${date}T${time}`,
        txn_date: date,
        jperiod,
        jyear,
        customer_id: null,
        customer_name: customerName,
        payment_method: paymentMethod,
        account_id: accountId,
        amount_received_rial: received,
        header_discount_rial: headerDiscount,
        note,
        created_at: nowIso(),
        created_by: actor?.id ?? null,
      },
      dedupeKey,
      'فروش',
    );

    if (customerName) {
      const cid = ensureParty(db, 'customers', customerName, body.customer_phone);
      db.run('UPDATE sales SET customer_id = ? WHERE id = ?', [cid, saleId]);
    }

    const snapshot = currentAvgCosts(db);
    for (const l of lines) {
      insert(db, 'sale_lines', {
        sale_id: saleId,
        product_id: l.product_id,
        description: l.description,
        kind: l.kind,
        qty_x1000: l.qty_x1000,
        unit_price_rial: l.unit_price_rial,
        line_total_rial: l.line_total_rial,
        discount_rial: l.discount_rial,
        cogs_rial: l.kind === 'sale' ? weightedCogsFor(snapshot, l.product_id, l.qty_x1000) : 0,
        origin_line_id: l.origin_line_id,
        created_at: nowIso(),
      });
    }

    refreshStockCache(db);
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'sale',
      entityId: saleId,
      action: 'create',
      after: { total_rial: totals.total, received_rial: received, lines: lines.length, date },
    });
    return readSale(db, saleId, { totals });
  });
}

/**
 * Weighted-average stock state per product *before* the write is applied, used
 * only to stamp an audit value (sale_lines.cogs_rial). Reports never read this;
 * they re-derive COGS by replaying the ledger.
 */
function currentAvgCosts(db) {
  const map = new Map();
  for (const p of db.all('SELECT id, stock_qty_x1000, stock_cost_rial FROM products')) {
    map.set(p.id, { qty: p.stock_qty_x1000, cost: p.stock_cost_rial });
  }
  return map;
}

function weightedCogsFor(snapshot, productId, qtyX1000) {
  const s = snapshot.get(productId);
  if (!s || s.qty <= 0 || s.cost <= 0) return 0;
  return Math.min(s.cost, Number(divRound(BigInt(qtyX1000) * BigInt(s.cost), BigInt(s.qty))));
}

/** Whole-unit cost, for display (stock totals are kept per thousandth). */
export function avgUnitCostRial(stockCostRial, stockQtyX1000, fallback = 0) {
  if (stockQtyX1000 > 0 && stockCostRial !== 0) return Number(divRound(BigInt(stockCostRial) * 1000n, BigInt(stockQtyX1000)));
  return fallback || 0;
}

export function ensureParty(db, table, name, phone = null) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!clean) return null;
  const existing = db.get(`SELECT id FROM ${table} WHERE name = ? COLLATE NOCASE`, [clean]);
  if (existing) {
    if (phone) db.run(`UPDATE ${table} SET phone = ? WHERE id = ? AND (phone IS NULL OR phone = '')`, [String(phone).slice(0, 30), existing.id]);
    return existing.id;
  }
  return insert(db, table, { name: clean, phone: phone ? String(phone).slice(0, 30) : null, created_at: nowIso() });
}

export function readSale(db, id, extra = {}) {
  const sale = db.get('SELECT * FROM sales WHERE id = ?', [id]);
  if (!sale) throw notFound('فروش موردنظر یافت نشد.');
  const lines = db.all('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY id', [id]);
  const settlements = db.all('SELECT * FROM settlements WHERE sale_id = ? ORDER BY txn_date, id', [id]);
  const settled = sumInt(settlements.map((s) => s.amount_rial));
  const gross = sumInt(lines.filter((l) => l.kind === 'sale').map((l) => l.line_total_rial));
  const discounts = sumInt(lines.map((l) => l.discount_rial)) + (sale.header_discount_rial || 0);
  const returns = sumInt(lines.filter((l) => l.kind === 'return').map((l) => l.line_total_rial - l.discount_rial));
  const total = gross - discounts - returns;
  const received = (sale.amount_received_rial || 0) + settled;
  return {
    ...sale,
    lines,
    settlements,
    computed: {
      gross_rial: gross,
      discounts_rial: discounts,
      returns_rial: returns,
      total_rial: total,
      received_rial: received,
      outstanding_rial: total - received,
      cogs_rial: sumInt(lines.map((l) => (l.kind === 'return' ? -l.cogs_rial : l.cogs_rial))),
      ...(extra.totals ? { totals_snapshot: extra.totals } : {}),
    },
  };
}

export function updateSale(db, actor, id, body) {
  const before = db.get('SELECT * FROM sales WHERE id = ?', [id]);
  if (!before) throw notFound('فروش موردنظر یافت نشد.');
  const reason = V.text('reason', { maxLength: 500, label: 'دلیل ویرایش' })(body);
  const beforeLines = db.all('SELECT id, product_id, qty_x1000, line_total_rial FROM sale_lines WHERE sale_id = ?', [id]);
  return db.tx(() => {
    const date = V.date('date', { label: 'تاریخ فروش', future: 'reject' })(body) || before.txn_date;
    const time = V.time('time')(body) || (before.occurred_at || '').slice(11, 16) || '00:00';
    const paymentMethod = V.oneOf('payment_method', METHODS, { label: 'روش پرداخت' })(body) || before.payment_method;
    const customerName = V.text('customer_name', { maxLength: 120 })(body);
    const { jperiod, jyear } = jp(date);
    const lines = normalizeSaleLines(db, body.lines, { forUpdate: true, saleId: id });
    const headerDiscount = amountField(body, { tomanField: 'discount_toman', rialField: 'discount_rial', required: false, min: 0, label: 'تخفیف' }) ?? 0;
    const totals = saleTotals(lines, headerDiscount);
    const settled = sumInt(db.all("SELECT amount_rial FROM settlements WHERE sale_id = ? AND type = 'customer_receipt'", [id]).map((s) => s.amount_rial));
    const already = before.amount_received_rial + settled;
    let received = amountField(body, { tomanField: 'received_toman', rialField: 'received_rial', required: false, min: 0, label: 'مبلغ دریافتی' });
    if (received === null) received = before.amount_received_rial;
    assertInvoiceReceipt({ received, settled, total: totals.total });
    if (received > already) throw badRequest('در ویرایش فاکتور نمی‌توان دریافتی را افزایش داد؛ برای دریافت وجه بعدی از بخش «وصول مطالبات» استفاده کنید.', { field: 'received_toman' });
    const accountId = received > 0 ? resolveAccount(db, { paymentMethod, accountId: body.account_id, label: 'واریز به' }) : null;
    db.run(
      `UPDATE sales SET occurred_at=?, txn_date=?, jperiod=?, jyear=?, customer_name=?, payment_method=?, account_id=?,
        amount_received_rial=?, header_discount_rial=?, note=?, updated_at=?, updated_by=? WHERE id=?`,
      [
        `${date}T${time}`,
        date,
        jperiod,
        jyear,
        customerName,
        paymentMethod,
        accountId,
        received,
        headerDiscount,
        V.text('note', { maxLength: 1000 })(body),
        nowIso(),
        actor?.id ?? null,
        id,
      ],
    );
    if (customerName) {
      const cid = ensureParty(db, 'customers', customerName);
      db.run('UPDATE sales SET customer_id = ? WHERE id = ?', [cid, id]);
    }
    const snapshot = currentAvgCosts(db);
    // Lines are updated in place when the caller sends back their `id`: return
    // records reference sale_lines by id, so dropping and recreating rows would
    // either break that reference or silently re-open the return cap.
    const keep = new Set(lines.map((l) => l.id).filter((x) => x != null));
    if (keep.size !== lines.filter((l) => l.id != null).length) {
      throw badRequest('شماره ردیف تکراری در ویرایش فاکتور مجاز نیست.', { field: 'lines[].id' });
    }
    const mine = new Set(db.all('SELECT id FROM sale_lines WHERE sale_id = ?', [id]).map((r) => r.id));
    for (const kid of keep) {
      if (!mine.has(kid)) throw badRequest('یکی از ردیف‌های ارسالی به این فاکتور مربوط نیست.', { field: 'lines[].id' });
    }
    const dropping = [...mine].filter((x) => !keep.has(x));
    if (dropping.length) {
      const ph = dropping.map(() => '?').join(',');
      const droppingSet = new Set(dropping);
      // A line may only disappear together with every return that points at it.
      const refs = db.all(`SELECT id, sale_id FROM sale_lines WHERE origin_line_id IN (${ph})`, dropping);
      const blocking = refs.filter((r) => !droppingSet.has(r.id) || r.sale_id !== id);
      if (blocking.length) {
        throw badRequest('یکی از ردیف‌هایی که می‌خواهید حذف کنید مرجوع شده است؛ اول رکورد مرجوعی را اصلاح یا حذف کنید.', {
          field: 'lines',
          details: { blocking_return_ids: blocking.map((r) => r.id) },
        });
      }
      db.run(`DELETE FROM sale_lines WHERE id IN (${ph})`, dropping);
    }
    for (const l of lines) {
      const row = {
        product_id: l.product_id,
        description: l.description,
        kind: l.kind,
        qty_x1000: l.qty_x1000,
        unit_price_rial: l.unit_price_rial,
        line_total_rial: l.line_total_rial,
        discount_rial: l.discount_rial,
        cogs_rial: l.kind === 'sale' ? weightedCogsFor(snapshot, l.product_id, l.qty_x1000) : 0,
        origin_line_id: l.origin_line_id,
      };
      if (l.id != null && keep.has(l.id)) {
        db.run(
          `UPDATE sale_lines SET product_id=?, description=?, kind=?, qty_x1000=?, unit_price_rial=?, line_total_rial=?,
             discount_rial=?, cogs_rial=?, origin_line_id=? WHERE id=?`,
          [row.product_id, row.description, row.kind, row.qty_x1000, row.unit_price_rial, row.line_total_rial, row.discount_rial, row.cogs_rial, row.origin_line_id, l.id],
        );
      } else {
        insert(db, 'sale_lines', { sale_id: id, ...row, created_at: nowIso() });
      }
    }
    refreshStockCache(db);
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'sale',
      entityId: id,
      action: 'update',
      before: { received_rial: before.amount_received_rial, date: before.txn_date, lines: beforeLines },
      after: { total_rial: totals.total, date },
      note: reason,
    });
    return readSale(db, id);
  });
}

export function deleteSale(db, actor, id, { reason } = {}) {
  const why = V.text('reason', { required: true, maxLength: 500, label: 'دلیل حذف' })({ reason });
  return db.tx(() => {
    const before = db.get('SELECT * FROM sales WHERE id = ?', [id]);
    if (!before) throw notFound('فروش موردنظر یافت نشد.');
    const linked = db.get("SELECT COUNT(*) AS n FROM settlements WHERE sale_id = ? AND type = 'customer_receipt'", [id]).n;
    if (linked) throw conflict('برای این فاکتور وصول مطالبات ثبت شده است؛ ابتدا آن‌ها را حذف کنید.', { settlements: linked });
    db.run('DELETE FROM sales WHERE id = ?', [id]);
    refreshStockCache(db);
    audit(db, { userId: actor?.id ?? null, entity: 'sale', entityId: id, action: 'delete', before, note: why });
    return { deleted: true, id: Number(id) };
  });
}

/* ------------------------------------------------------------ purchases --- */

export function createPurchase(db, actor, body) {
  const date = V.date('purchase_date', { label: 'تاریخ خرید', future: 'reject' })(body);
  const paymentMethod = V.oneOf('payment_method', METHODS, { label: 'روش پرداخت' })(body);
  const supplierName = V.text('supplier_name', { maxLength: 120, label: 'تأمین‌کننده' })(body);
  const note = V.text('note', { maxLength: 1000, label: 'یادداشت' })(body);
  const extraNote = V.text('extra_cost_note', { maxLength: 300, label: 'شرح هزینه جانبی' })(body);
  const dedupeKey = V.uuid()(body);
  const { jperiod, jyear } = jp(date);
  if (!Array.isArray(body.lines) || !body.lines.length) throw badRequest('حداقل یک ردیف کالا برای ثبت خرید لازم است.', { field: 'lines' });
  if (body.lines.length > 100) throw badRequest('حداکثر ۱۰۰ ردیف در یک فاکتور خرید.', { field: 'lines' });

  return db.tx(() => {
    const lines = [];
    for (const [idx, raw] of body.lines.entries()) {
      const label = `ردیف ${idx + 1}`;
      const product = raw.product_id
        ? db.get('SELECT * FROM products WHERE id = ?', [Number(raw.product_id)])
        : ensureProduct(db, {
            name: raw.product_name || raw.description || '',
            sku: raw.sku,
            kind: 'goods',
            unit: raw.unit || 'عدد',
          });
      if (!product) throw badRequest(`برای «${label}» کالا را انتخاب یا نام آن را وارد کنید.`, { field: `lines[${idx}].product_id` });
      const qty = qtyField(raw.qty_x1000 ?? raw.qty, label);
      const unit = amountField(raw, { tomanField: 'unit_cost_toman', rialField: 'unit_cost_rial', required: true, min: 0, label: `بهای واحد ${label}` }) ?? 0;
      lines.push({
        product_id: product.id,
        qty_x1000: qty,
        unit_cost_rial: unit,
        line_total_rial: lineTotalRial(qty, unit),
      });
    }
    const goods = sumInt(lines.map((l) => l.line_total_rial));
    const extra = amountField(body, { tomanField: 'extra_cost_toman', rialField: 'extra_cost_rial', required: false, min: 0, label: 'هزینه جانبی (حمل و…)' }) ?? 0;
    const total = goods + extra;
    let paid = amountField(body, { tomanField: 'paid_toman', rialField: 'paid_rial', required: false, min: 0, label: 'مبلغ پرداختی' });
    if (paid === null) paid = paymentMethod === 'credit' ? 0 : total;
    if (paid > total) throw badRequest('مبلغ پرداختی نمی‌تواند بیشتر از کل فاکتور خرید باشد.', { field: 'paid_toman' });
    const accountId = paid > 0 ? resolveAccount(db, { paymentMethod, accountId: body.account_id, label: 'برداشت از' }) : null;

    const id = withDedupe(
      db,
      'purchases',
      {
        purchase_date: date,
        jperiod,
        jyear,
        supplier_id: supplierName ? ensureParty(db, 'suppliers', supplierName, body.supplier_phone) : null,
        supplier_name: supplierName,
        extra_cost_rial: extra,
        extra_cost_note: extraNote,
        payment_method: paymentMethod,
        account_id: accountId,
        amount_paid_rial: paid,
        note,
        created_at: nowIso(),
        created_by: actor?.id ?? null,
      },
      dedupeKey,
      'خرید',
    );
    for (const l of lines) insert(db, 'purchase_lines', { purchase_id: id, ...l, created_at: nowIso() });
    refreshStockCache(db);
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'purchase',
      entityId: id,
      action: 'create',
      after: { goods_rial: goods, extra_rial: extra, total_rial: total, paid_rial: paid, lines: lines.length, date },
    });
    return readPurchase(db, id);
  });
}

export function readPurchase(db, id) {
  const p = db.get('SELECT * FROM purchases WHERE id = ?', [id]);
  if (!p) throw notFound('خرید موردنظر یافت نشد.');
  const lines = db.all(
    `SELECT pl.*, pr.name AS product_name, pr.unit, pr.stock_qty_x1000
       FROM purchase_lines pl JOIN products pr ON pr.id = pl.product_id WHERE pl.purchase_id = ? ORDER BY pl.id`,
    [id],
  );
  const shares = allocateExtraCost(lines, p.extra_cost_rial);
  for (const l of lines) {
    l.allocated_extra_rial = shares.get(l.id) || 0;
    l.total_with_extra_rial = l.line_total_rial + l.allocated_extra_rial;
  }
  const goods = sumInt(lines.map((l) => l.line_total_rial));
  const total = goods + (p.extra_cost_rial || 0);
  const settled = sumInt(db.all("SELECT amount_rial FROM settlements WHERE purchase_id = ? AND type = 'supplier_payment'", [id]).map((s) => s.amount_rial));
  return {
    ...p,
    lines,
    computed: {
      goods_cost_rial: goods,
      extra_cost_rial: p.extra_cost_rial || 0,
      total_rial: total,
      paid_rial: (p.amount_paid_rial || 0) + settled,
      outstanding_rial: total - (p.amount_paid_rial || 0) - settled,
    },
  };
}

export function updatePurchase(db, actor, id, body) {
  const before = db.get('SELECT * FROM purchases WHERE id = ?', [id]);
  if (!before) throw notFound('خرید موردنظر یافت نشد.');
  const reason = V.text('reason', { maxLength: 500, label: 'دلیل ویرایش' })(body);
  return db.tx(() => {
    db.run('DELETE FROM purchase_lines WHERE purchase_id = ?', [id]);
    const result = { id };
    // rebuild by reusing the create validation rules on the remaining fields
    const date = V.date('purchase_date', { label: 'تاریخ خرید', future: 'reject' })(body) || before.purchase_date;
    const { jperiod, jyear } = jp(date);
    const paymentMethod = V.oneOf('payment_method', METHODS, { label: 'روش پرداخت' })(body) || before.payment_method;
    if (!Array.isArray(body.lines) || !body.lines.length) throw badRequest('حداقل یک ردیف کالا لازم است.', { field: 'lines' });
    const lines = [];
    for (const [idx, raw] of body.lines.entries()) {
      const product = raw.product_id
        ? db.get('SELECT * FROM products WHERE id = ?', [Number(raw.product_id)])
        : ensureProduct(db, { name: raw.product_name || raw.description || '', sku: raw.sku, kind: 'goods', unit: raw.unit || 'عدد' });
      if (!product) throw badRequest(`کالای ردیف ${idx + 1} یافت نشد.`, { field: 'lines' });
      const qty = qtyField(raw.qty_x1000 ?? raw.qty, `ردیف ${idx + 1}`);
      const unit = amountField(raw, { tomanField: 'unit_cost_toman', rialField: 'unit_cost_rial', required: true, min: 0, label: 'بهای واحد' }) ?? 0;
      lines.push({ product_id: product.id, qty_x1000: qty, unit_cost_rial: unit, line_total_rial: lineTotalRial(qty, unit) });
    }
    const goods = sumInt(lines.map((l) => l.line_total_rial));
    const extra = amountField(body, { tomanField: 'extra_cost_toman', rialField: 'extra_cost_rial', required: false, min: 0, label: 'هزینه جانبی' }) ?? 0;
    const total = goods + extra;
    let paid = amountField(body, { tomanField: 'paid_toman', rialField: 'paid_rial', required: false, min: 0, label: 'پرداختی' });
    if (paid === null) paid = before.amount_paid_rial;
    if (paid > total) throw badRequest('مبلغ پرداختی بیش از کل فاکتور است.', { field: 'paid_toman' });
    const settled = sumInt(db.all("SELECT amount_rial FROM settlements WHERE purchase_id = ? AND type = 'supplier_payment'", [id]).map((s) => s.amount_rial));
    if (paid + settled > total) throw badRequest('مبلغ پرداختی (با احتساب تسویه‌های قبلی) از کل فاکتور بیشتر است.', { field: 'paid_toman' });
    const accountId = paid > 0 ? resolveAccount(db, { paymentMethod, accountId: body.account_id, label: 'برداشت از' }) : null;
    db.run(
      `UPDATE purchases SET purchase_date=?, jperiod=?, jyear=?, supplier_name=?, extra_cost_rial=?, extra_cost_note=?,
         payment_method=?, account_id=?, amount_paid_rial=?, note=?, updated_at=?, updated_by=? WHERE id=?`,
      [
        date,
        jperiod,
        jyear,
        V.text('supplier_name', { maxLength: 120 })(body) ?? before.supplier_name,
        extra,
        V.text('extra_cost_note', { maxLength: 300 })(body),
        paymentMethod,
        accountId,
        paid,
        V.text('note', { maxLength: 1000 })(body),
        nowIso(),
        actor?.id ?? null,
        id,
      ],
    );
    for (const l of lines) insert(db, 'purchase_lines', { purchase_id: id, ...l, created_at: nowIso() });
    refreshStockCache(db);
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'purchase',
      entityId: id,
      action: 'update',
      before: { total_rial: before.amount_paid_rial, date: before.purchase_date },
      after: { total_rial: total, date },
      note: reason,
    });
    return readPurchase(db, id) || result;
  });
}

export function deletePurchase(db, actor, id, { reason } = {}) {
  const why = V.text('reason', { required: true, maxLength: 500, label: 'دلیل حذف' })({ reason });
  return db.tx(() => {
    const before = db.get('SELECT * FROM purchases WHERE id = ?', [id]);
    if (!before) throw notFound('خرید موردنظر یافت نشد.');
    const rows = db.all('SELECT product_id, qty_x1000 FROM purchase_lines WHERE purchase_id = ?', [id]);
    for (const r of rows) {
      const st = db.get('SELECT stock_qty_x1000 FROM products WHERE id = ?', [r.product_id]);
      if (st && st.stock_qty_x1000 < r.qty_x1000) {
        throw conflict('حذف این خرید باعث موجودی منفی می‌شود؛ ابتدا فروش‌های مرتبط را اصلاح کنید.', { product_id: r.product_id });
      }
    }
    db.run('DELETE FROM purchases WHERE id = ?', [id]);
    refreshStockCache(db);
    audit(db, { userId: actor?.id ?? null, entity: 'purchase', entityId: id, action: 'delete', before, note: why });
    return { deleted: true, id: Number(id) };
  });
}

/* -------------------------------------------------------------- expenses -- */

export function createExpense(db, actor, body) {
  const date = V.date('date', { label: 'تاریخ هزینه', future: 'reject' })(body);
  const category = V.oneOf('category', CATEGORIES, { label: 'دستهٔ هزینه' })(body);
  const paymentMethod = V.oneOf('payment_method', METHODS, { label: 'روش پرداخت' })(body);
  const note = V.text('note', { maxLength: 1000, label: 'یادداشت' })(body);
  const dedupeKey = V.uuid()(body);
  const amount = amountField(body, { tomanField: 'amount_toman', rialField: 'amount_rial', required: true, min: 10, label: 'مبلغ هزینه' });
  const { jperiod, jyear } = jp(date);
  return db.tx(() => {
    const paidDefault = paymentMethod === 'credit' ? 0 : amount;
    let paid = amountField(body, { tomanField: 'paid_toman', rialField: 'paid_rial', required: false, min: 0, label: 'پرداخت‌شده' });
    if (paid === null || paid === undefined) paid = paidDefault;
    if (paid > amount) throw badRequest('پرداختی نمی‌تواند بیشتر از مبلغ هزینه باشد.', { field: 'paid_toman' });
    const accountId = paid > 0 ? resolveAccount(db, { paymentMethod, accountId: body.account_id, label: 'برداشت از' }) : null;
    const id = withDedupe(
      db,
      'expenses',
      {
        expense_date: date,
        jperiod,
        jyear,
        category,
        amount_rial: amount,
        amount_paid_rial: paid === amount ? null : paid,
        payment_method: paymentMethod,
        account_id: accountId,
        note,
        created_at: nowIso(),
        created_by: actor?.id ?? null,
      },
      dedupeKey,
      'هزینه',
    );
    audit(db, { userId: actor?.id ?? null, entity: 'expense', entityId: id, action: 'create', after: { amount_rial: amount, paid_rial: paid, category, date } });
    return { id, amount_rial: amount, paid_rial: paid, outstanding_rial: amount - paid };
  });
}

export function updateExpense(db, actor, id, body) {
  const before = db.get('SELECT * FROM expenses WHERE id = ?', [id]);
  if (!before) throw notFound('هزینه موردنظر یافت نشد.');
  const reason = V.text('reason', { maxLength: 500, label: 'دلیل ویرایش' })(body);
  return db.tx(() => {
    const date = V.date('date', { label: 'تاریخ هزینه', future: 'reject' })(body) || before.expense_date;
    const { jperiod, jyear } = jp(date);
    const category = V.oneOf('category', CATEGORIES, { label: 'دستهٔ هزینه' })(body) || before.category;
    const paymentMethod = V.oneOf('payment_method', METHODS, { label: 'روش پرداخت' })(body) || before.payment_method;
    const amount = amountField(body, { tomanField: 'amount_toman', rialField: 'amount_rial', required: false, min: 10, label: 'مبلغ هزینه' }) ?? before.amount_rial;
    let paid = amountField(body, { tomanField: 'paid_toman', rialField: 'paid_rial', required: false, min: 0, label: 'پرداخت‌شده' });
    if (paid === null || paid === undefined) paid = before.amount_paid_rial === null ? before.amount_rial : before.amount_paid_rial;
    if (paid > amount) throw badRequest('پرداختی بیش از مبلغ هزینه است.', { field: 'paid_toman' });
    const accountId = paid > 0 ? resolveAccount(db, { paymentMethod, accountId: body.account_id ?? before.account_id, label: 'برداشت از' }) : null;
    db.run(
      `UPDATE expenses SET expense_date=?, jperiod=?, jyear=?, category=?, amount_rial=?, amount_paid_rial=?,
        payment_method=?, account_id=?, note=?, updated_at=?, updated_by=? WHERE id=?`,
      [
        date,
        jperiod,
        jyear,
        category,
        amount,
        paid === amount ? null : paid,
        paymentMethod,
        accountId,
        V.text('note', { maxLength: 1000 })(body) ?? before.note,
        nowIso(),
        actor?.id ?? null,
        id,
      ],
    );
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'expense',
      entityId: id,
      action: 'update',
      before: { amount_rial: before.amount_rial, category: before.category, date: before.expense_date },
      after: { amount_rial: amount, category, date },
      note: reason,
    });
    return db.get('SELECT * FROM expenses WHERE id = ?', [id]);
  });
}

export function deleteExpense(db, actor, id, { reason } = {}) {
  const why = V.text('reason', { required: true, maxLength: 500, label: 'دلیل حذف' })({ reason });
  return db.tx(() => {
    const before = db.get('SELECT * FROM expenses WHERE id = ?', [id]);
    if (!before) throw notFound('هزینه موردنظر یافت نشد.');
    db.run('DELETE FROM expenses WHERE id = ?', [id]);
    audit(db, { userId: actor?.id ?? null, entity: 'expense', entityId: id, action: 'delete', before, note: why });
    return { deleted: true, id: Number(id) };
  });
}

/* ---------------------------------------------------- FX rates (manual) --- */

/**
 * Manual USD rate entry. One row per date, so saving today's rate can never
 * overwrite an earlier day's record. Corrections keep an audit trail, and the
 * previous value is preserved in audit_log.before_json.
 */
export function upsertFxRate(db, actor, body) {
  const date = V.date('effective_date', { label: 'تاریخ نرخ', future: 'reject' })(body);
  const note = V.text('note', { maxLength: 500, label: 'یادداشت' })(body);
  const rateRial = amountField(body, { tomanField: 'rate_toman', rialField: 'rate_rial', required: true, min: 10, max: 9_000_000_000_000_000, label: 'نرخ دلار' });
  // rate stored as toman × 100 → rial × 10 (exact, integer)
  const rate_x100 = Number(BigInt(rateRial) * 10n);
  const existing = db.get('SELECT * FROM fx_rates WHERE effective_date = ?', [date]);
  return db.tx(() => {
    if (existing) {
      db.run('UPDATE fx_rates SET rate_toman_x100 = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?', [
        rate_x100,
        note,
        nowIso(),
        actor?.id ?? null,
        existing.id,
      ]);
      audit(db, {
        userId: actor?.id ?? null,
        entity: 'fx_rate',
        entityId: existing.id,
        action: 'correct',
        before: { effective_date: date, rate_toman_x100: existing.rate_toman_x100, note: existing.note },
        after: { effective_date: date, rate_toman_x100: rate_x100, note },
        note: V.text('reason', { maxLength: 300, label: 'دلیل اصلاح' })(body),
      });
      return publicFxRow(db.get('SELECT * FROM fx_rates WHERE id = ?', [existing.id]));
    }
    const id = insert(db, 'fx_rates', {
      effective_date: date,
      rate_toman_x100: rate_x100,
      source: 'manual',
      note,
      created_at: nowIso(),
      created_by: actor?.id ?? null,
    });
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'fx_rate',
      entityId: id,
      action: 'create',
      after: { effective_date: date, rate_toman_x100: rate_x100, note },
    });
    return publicFxRow(db.get('SELECT * FROM fx_rates WHERE id = ?', [id]));
  });
}

export function publicFxRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    effective_date: row.effective_date,
    rate_toman_x100: row.rate_toman_x100,
    note: row.note ?? null,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  };
}

/* ------------------------------------------------- inflation assumption --- */

export function upsertInflation(db, actor, body) {
  const period = V.jperiod('period', { label: 'دوره (ماه جلالی)' })(body);
  if (!/^\d{4}-\d{2}$/.test(period)) throw badRequest('فرض تورم فقط برای ماه ثبت می‌شود (مثال ۱۴۰۵-۰۲).', { field: 'period' });
  const rate = parsePctX100(body.rate_pct);
  if (rate === null) throw badRequest('نرخ تورم باید عددی با حداکثر دو رقم اعشار باشد (درصد).', { field: 'rate_pct' });
  if (rate < -10000 || rate > 1000000) throw badRequest('نرخ تورم خارج از بازهٔ منطقی است (٪).', { field: 'rate_pct' });
  const note = V.text('note', { maxLength: 500 })(body);
  const existing = db.get('SELECT * FROM inflation_assumptions WHERE period = ?', [period]);
  return db.tx(() => {
    if (existing) {
      db.run('UPDATE inflation_assumptions SET rate_pct_x100 = ?, note = ?, updated_at = ? WHERE period = ?', [rate, note, nowIso(), period]);
      audit(db, {
        userId: actor?.id ?? null,
        entity: 'inflation_assumption',
        entityId: period,
        action: 'correct',
        before: { rate_pct_x100: existing.rate_pct_x100 },
        after: { rate_pct_x100: rate, note },
        note: V.text('reason', { maxLength: 300 })(body),
      });
    } else {
      db.run('INSERT INTO inflation_assumptions (period, rate_pct_x100, note, created_at) VALUES (?,?,?,?)', [period, rate, note, nowIso()]);
      audit(db, { userId: actor?.id ?? null, entity: 'inflation_assumption', entityId: period, action: 'create', after: { rate_pct_x100: rate, note } });
    }
    return db.get('SELECT * FROM inflation_assumptions WHERE period = ?', [period]);
  });
}

export function deleteInflation(db, actor, period) {
  const existing = db.get('SELECT * FROM inflation_assumptions WHERE period = ?', [period]);
  if (!existing) throw notFound('فرض تورمی برای این دوره ثبت نشده است.');
  db.run('DELETE FROM inflation_assumptions WHERE period = ?', [period]);
  audit(db, { userId: actor?.id ?? null, entity: 'inflation_assumption', entityId: period, action: 'delete', before: existing });
  return { deleted: true, period };
}

/* ---------------------------------------------------- products & inventory */

export function createProduct(db, actor, body) {
  const name = V.text('name', { required: true, maxLength: 120, label: 'نام کالا/خدمت' })(body);
  const sku = V.text('sku', { maxLength: 60, label: 'کد کالا' })(body);
  const kind = V.oneOf('kind', ['goods', 'service'], { required: false, label: 'نوع' })(body) || 'goods';
  const unit = V.text('unit', { maxLength: 20, label: 'واحد' })(body) || 'عدد';
  const note = V.text('note', { maxLength: 500 })(body);
  const opening = readOpeningInventory(db, body);
  return db.tx(() => {
    const dup = db.get('SELECT id FROM products WHERE name = ? COLLATE NOCASE', [name]);
    if (dup) throw conflict('کالا/خدمتی با این نام قبلاً ثبت شده است.', { existing_id: dup.id });
    const id = insert(db, 'products', {
      name,
      sku,
      kind,
      unit,
      note,
      opening_qty_x1000: opening.qty,
      opening_cost_rial: opening.cost,
      created_at: nowIso(),
    });
    refreshStockCache(db);
    audit(db, { userId: actor?.id ?? null, entity: 'product', entityId: id, action: 'create', after: { name, kind, sku } });
    return readProduct(db, id);
  });
}

/**
 * Opening stock is the count and cost a shop already had before it started using
 * the app. It is entered as a quantity plus a *unit* cost (that is how owners
 * think) and stored as a total, and it is never revenue or an expense.
 */
export function readOpeningInventory(db, body) {
  const qty = parseQtyX1000(body.opening_qty ?? 0, { allowNegative: false }) || 0;
  const unitRial = amountField(body, { tomanField: 'opening_unit_cost_toman', rialField: 'opening_unit_cost_rial', required: false, min: 0, label: 'بهای هر واحد در شروع' });
  const totalRial = amountField(body, { tomanField: 'opening_cost_toman', rialField: 'opening_cost_rial', required: false, min: 0, label: 'مجموع بهای شروع' });
  if (unitRial !== null && totalRial !== null) {
    throw badRequest('فقط یکی از «بهای هر واحد» یا «مجموع بهای» موجودی بازگشایی را وارد کنید.', { field: 'opening_unit_cost_toman' });
  }
  let cost = 0;
  if (unitRial !== null) {
    if (!qty) throw badRequest('برای بهای واحد موجودی بازگشایی، مقدار هم لازم است.', { field: 'opening_qty' });
    cost = Number(mulDiv(qty, unitRial, 1000));
  } else if (totalRial !== null) {
    cost = totalRial;
  }
  return { qty, cost };
}

export function updateProduct(db, actor, id, body) {
  const before = db.get('SELECT * FROM products WHERE id = ?', [id]);
  if (!before) throw notFound('کالا/خدمت موردنظر یافت نشد.');
  const name = V.text('name', { maxLength: 120, label: 'نام' })(body) ?? before.name;
  const sku = V.text('sku', { maxLength: 60 })(body) ?? before.sku;
  const unit = V.text('unit', { maxLength: 20 })(body) ?? before.unit;
  const note = V.text('note', { maxLength: 500 })(body) ?? before.note;
  const active = body.active === undefined ? before.active : body.active ? 1 : 0;
  const kind = V.oneOf('kind', ['goods', 'service'], { required: false, label: 'نوع' })(body) ?? before.kind;
  const replacement = amountField(body, { tomanField: 'replacement_cost_toman', rialField: 'replacement_cost_rial', required: false, min: 0, label: 'هزینهٔ جایگزینی' });
  const reason = V.text('reason', { maxLength: 300 })(body);
  const opening = body.opening_qty === undefined && body.opening_unit_cost_toman === undefined && body.opening_cost_toman === undefined
    ? null
    : readOpeningInventory(db, body);
  return db.tx(() => {
    db.run('UPDATE products SET name=?, sku=?, unit=?, note=?, active=?, kind=? WHERE id=?', [name, sku, unit, note, active, kind, id]);
    if (opening) {
      db.run('UPDATE products SET opening_qty_x1000 = ?, opening_cost_rial = ? WHERE id = ?', [opening.qty, opening.cost, id]);
    }
    if (replacement !== null) {
      if (replacement < 0) throw badRequest('هزینهٔ جایگزینی نمی‌تواند منفی باشد.', { field: 'replacement_cost_toman' });
      db.run('UPDATE products SET replacement_unit_cost_rial = ?, replacement_cost_at = ? WHERE id = ?', [replacement, nowIso(), id]);
    } else if (body.clear_replacement_cost) {
      db.run('UPDATE products SET replacement_unit_cost_rial = NULL, replacement_cost_at = NULL WHERE id = ?', [id]);
    }
    refreshStockCache(db);
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'product',
      entityId: id,
      action: 'update',
      before: { name: before.name, kind: before.kind, replacement: before.replacement_unit_cost_rial },
      after: { name, kind, replacement: replacement ?? null },
      note: reason,
    });
    return readProduct(db, id);
  });
}

export function readProduct(db, id) {
  const row = db.get('SELECT * FROM products WHERE id = ?', [id]);
  if (!row) return null;
  return {
    ...row,
    avg_unit_cost_rial: avgUnitCostRial(row.stock_cost_rial, row.stock_qty_x1000, row.last_avg_cost_rial),
    inventory_value_rial: row.stock_cost_rial,
  };
}

export function deleteProduct(db, actor, id) {
  const before = db.get('SELECT * FROM products WHERE id = ?', [id]);
  if (!before) throw notFound('کالا/خدمت موردنظر یافت نشد.');
  const used = db.get(
    `SELECT (SELECT COUNT(*) FROM sale_lines WHERE product_id = ?) + (SELECT COUNT(*) FROM purchase_lines WHERE product_id = ?) AS n`,
    [id, id],
  ).n;
  if (used) throw conflict('این کالا در تراکنش‌ها استفاده شده و قابل حذف نیست؛ می‌توانید آن را از لیست مخفی (غیرفعال) کنید.', { referenced_rows: used });
  return db.tx(() => {
    db.run('DELETE FROM products WHERE id = ?', [id]);
    audit(db, { userId: actor?.id ?? null, entity: 'product', entityId: id, action: 'delete', before });
    return { deleted: true, id: Number(id) };
  });
}

export function createAdjustment(db, actor, body) {
  const date = V.date('date', { label: 'تاریخ', future: 'reject' })(body);
  const { jperiod, jyear } = jp(date);
  const productId = Number(body.product_id);
  const product = db.get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw badRequest('کالا انتخاب نشده است.', { field: 'product_id' });
  const reason = V.oneOf('reason', ['shrinkage', 'damage', 'expiry', 'theft', 'count_surplus', 'revaluation', 'other'], { label: 'دلیل' })(body);
  const note = V.text('note', { maxLength: 500 })(body);
  const dedupeKey = V.uuid()(body);
  const signedQty = parseQtyX1000(body.delta_qty ?? body.delta_qty_x1000, { allowNegative: true });
  if (!signedQty) throw badRequest('مقدار اصلاحی باید غیرصفر باشد (مثبت برای اضافه، منفی برای کسر).', { field: 'delta_qty' });
  const customCost = amountField(body, { tomanField: 'unit_cost_toman', rialField: 'unit_cost_rial', required: false, min: 0, label: 'بهای واحد' });
  return db.tx(() => {
    const avg = avgUnitCostRial(product.stock_cost_rial, product.stock_qty_x1000, product.last_avg_cost_rial);
    const unit = customCost ?? avg;
    if (signedQty < 0 && -signedQty > product.stock_qty_x1000) {
      throw badRequest('مقدار کسر موجودی بیشتر از موجودی فعلی است.', { field: 'delta_qty' });
    }
    const costImpact = Number(divRound(BigInt(-signedQty) * BigInt(unit), 1000n));
    const id = withDedupe(
      db,
      'inventory_adjustments',
      {
        txn_date: date,
        jperiod,
        jyear,
        product_id: product.id,
        delta_qty_x1000: signedQty,
        unit_cost_rial: unit,
        cost_impact_rial: costImpact,
        reason,
        note,
        created_at: nowIso(),
        created_by: actor?.id ?? null,
      },
      dedupeKey,
      'اصلاح موجودی',
    );
    refreshStockCache(db);
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'inventory_adjustment',
      entityId: id,
      action: 'create',
      after: { product_id: product.id, delta_qty_x1000: signedQty, unit_cost_rial: unit, cost_impact_rial: costImpact, reason },
    });
    return db.get('SELECT * FROM inventory_adjustments WHERE id = ?', [id]);
  });
}

/* ------------------------------------------- accounts / settlements / cash */

export function createAccount(db, actor, body) {
  const name = V.text('name', { required: true, maxLength: 80, label: 'نام حساب' })(body);
  const type = V.oneOf('type', ['cash', 'bank'], { label: 'نوع حساب' })(body);
  const opening = amountField(body, { tomanField: 'opening_balance_toman', rialField: 'opening_balance_rial', required: false, min: 0, label: 'موجودی بازگشایی' }) ?? 0;
  const isDefault = body.is_default ? 1 : 0;
  return db.tx(() => {
    if (db.get('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE', [name])) throw conflict('حسابی با این نام وجود دارد.', { field: 'name' });
    const count = db.get('SELECT COUNT(*) AS n FROM accounts').n;
    const id = insert(db, 'accounts', {
      name,
      type,
      opening_balance_rial: opening,
      is_default: isDefault || count === 0 ? 1 : 0,
      created_at: nowIso(),
    });
    if (isDefault) db.run('UPDATE accounts SET is_default = 0 WHERE id <> ?', [id]);
    audit(db, { userId: actor?.id ?? null, entity: 'account', entityId: id, action: 'create', after: { name, type, opening } });
    return db.get('SELECT * FROM accounts WHERE id = ?', [id]);
  });
}

export function updateAccount(db, actor, id, body) {
  const before = db.get('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!before) throw notFound('حساب موردنظر یافت نشد.');
  const name = V.text('name', { maxLength: 80, label: 'نام حساب' })(body) ?? before.name;
  const opening = amountField(body, { tomanField: 'opening_balance_toman', rialField: 'opening_balance_rial', required: false, min: 0, label: 'موجودی بازگشایی' });
  return db.tx(() => {
    db.run('UPDATE accounts SET name = ?, archived = ?, opening_balance_rial = ? WHERE id = ?', [
      name,
      body.archived ? 1 : 0,
      opening === null ? before.opening_balance_rial : opening,
      id,
    ]);
    if (body.is_default) db.run('UPDATE accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'account',
      entityId: id,
      action: 'update',
      before: { name: before.name, opening_balance_rial: before.opening_balance_rial },
      after: { name, opening_balance_rial: opening ?? before.opening_balance_rial },
      note: V.text('reason', { maxLength: 300 })(body),
    });
    return db.get('SELECT * FROM accounts WHERE id = ?', [id]);
  });
}

export function createSettlement(db, actor, body) {
  const type = V.oneOf('type', ['customer_receipt', 'supplier_payment'], { label: 'نوع تسویه' })(body);
  const date = V.date('date', { label: 'تاریخ', future: 'reject' })(body);
  const { jperiod, jyear } = jp(date);
  const amount = amountField(body, { tomanField: 'amount_toman', rialField: 'amount_rial', required: true, min: 10, label: 'مبلغ' });
  const paymentMethod = V.oneOf('payment_method', METHODS, { required: false, label: 'روش پرداخت' })(body) || (type === 'customer_receipt' ? 'cash' : 'cash');
  const note = V.text('note', { maxLength: 1000 })(body);
  const dedupeKey = V.uuid()(body);
  return db.tx(() => {
    let outstanding = null;
    let customerId = null;
    let supplierId = null;
    const saleId = body.sale_id ? Number(body.sale_id) : null;
    const purchaseId = body.purchase_id ? Number(body.purchase_id) : null;
    if (type === 'customer_receipt') {
      if (saleId) {
        const s = readSale(db, saleId);
        outstanding = s.computed.outstanding_rial;
        customerId = s.customer_id;
        if (outstanding >= 0 && amount > outstanding) {
          throw badRequest('مبلغ وصول بیشتر از ماندهٔ این فاکتور است.', { field: 'amount_toman', outstanding_rial: outstanding });
        }
      } else {
        const name = V.text('customer_name', { required: true, maxLength: 120, label: 'نام مشتری' })(body);
        customerId = ensureParty(db, 'customers', name);
      }
    } else {
      if (purchaseId) {
        const p = readPurchase(db, purchaseId);
        outstanding = p.computed.outstanding_rial;
        supplierId = p.supplier_id;
        if (amount > outstanding) throw badRequest('مبلغ پرداخت بیشتر از ماندهٔ این خرید است.', { field: 'amount_toman', outstanding_rial: outstanding });
      } else {
        const name = V.text('supplier_name', { required: true, maxLength: 120, label: 'نام تأمین‌کننده' })(body);
        supplierId = ensureParty(db, 'suppliers', name);
      }
    }
    const accountId = resolveAccount(db, {
      paymentMethod,
      accountId: body.account_id,
      label: type === 'customer_receipt' ? 'واریز به' : 'برداشت از',
    });
    const id = withDedupe(
      db,
      'settlements',
      {
        txn_date: date,
        jperiod,
        jyear,
        type,
        customer_id: customerId,
        supplier_id: supplierId,
        sale_id: saleId,
        purchase_id: purchaseId,
        amount_rial: amount,
        payment_method: paymentMethod,
        account_id: accountId,
        note,
        created_at: nowIso(),
        created_by: actor?.id ?? null,
      },
      dedupeKey,
      type === 'customer_receipt' ? 'وصول مطالبات' : 'پرداخت به تأمین‌کننده',
    );
    audit(db, {
      userId: actor?.id ?? null,
      entity: 'settlement',
      entityId: id,
      action: 'create',
      after: { type, amount_rial: amount, date, sale_id: saleId, purchase_id: purchaseId },
    });
    return db.get('SELECT * FROM settlements WHERE id = ?', [id]);
  });
}

export function deleteSettlement(db, actor, id, { reason } = {}) {
  const why = V.text('reason', { required: true, maxLength: 500, label: 'دلیل حذف' })({ reason });
  return db.tx(() => {
    const before = db.get('SELECT * FROM settlements WHERE id = ?', [id]);
    if (!before) throw notFound('تسویه موردنظر یافت نشد.');
    db.run('DELETE FROM settlements WHERE id = ?', [id]);
    audit(db, { userId: actor?.id ?? null, entity: 'settlement', entityId: id, action: 'delete', before, note: why });
    return { deleted: true, id: Number(id) };
  });
}

export function createCapitalTxn(db, actor, body) {
  const type = V.oneOf('type', ['deposit', 'withdrawal'], { label: 'نوع' })(body);
  const date = V.date('date', { label: 'تاریخ', future: 'reject' })(body);
  const { jperiod, jyear } = jp(date);
  const amount = amountField(body, { tomanField: 'amount_toman', rialField: 'amount_rial', required: true, min: 10, label: 'مبلغ' });
  const note = V.text('note', { maxLength: 1000 })(body);
  const dedupeKey = V.uuid()(body);
  return db.tx(() => {
    const accountId = resolveAccount(db, { paymentMethod: 'cash', accountId: body.account_id, label: type === 'deposit' ? 'واریز به' : 'برداشت از' });
    const id = withDedupe(
      db,
      'capital_txns',
      { txn_date: date, jperiod, jyear, type, amount_rial: amount, payment_method: 'cash', account_id: accountId, note, created_at: nowIso(), created_by: actor?.id ?? null },
      dedupeKey,
      type === 'deposit' ? 'وارسه سرمایه' : 'برداشت سرمایه',
    );
    audit(db, { userId: actor?.id ?? null, entity: 'capital_txn', entityId: id, action: 'create', after: { type, amount_rial: amount, date } });
    return db.get('SELECT * FROM capital_txns WHERE id = ?', [id]);
  });
}

export function createLoanTxn(db, actor, body) {
  const type = V.oneOf('type', ['loan_in', 'loan_repayment', 'loan_interest'], { label: 'نوع' })(body);
  const date = V.date('date', { label: 'تاریخ', future: 'reject' })(body);
  const { jperiod, jyear } = jp(date);
  const amount = amountField(body, { tomanField: 'amount_toman', rialField: 'amount_rial', required: true, min: 10, label: 'مبلغ' });
  const counterparty = V.text('counterparty', { maxLength: 120, label: 'طرف حساب' })(body);
  const note = V.text('note', { maxLength: 1000 })(body);
  const dedupeKey = V.uuid()(body);
  return db.tx(() => {
    const accountId =
      type === 'loan_interest'
        ? resolveAccount(db, { paymentMethod: 'cash', accountId: body.account_id, label: 'برداشت از' })
        : resolveAccount(db, { paymentMethod: 'cash', accountId: body.account_id, label: type === 'loan_in' ? 'واریز به' : 'برداشت از' });
    const id = withDedupe(
      db,
      'loans',
      {
        txn_date: date,
        jperiod,
        jyear,
        type,
        amount_rial: amount,
        counterparty,
        payment_method: 'cash',
        account_id: accountId,
        note,
        created_at: nowIso(),
        created_by: actor?.id ?? null,
      },
      dedupeKey,
      type === 'loan_in' ? 'دریافت وام' : type === 'loan_repayment' ? 'قسط وام' : 'بهره وام',
    );
    audit(db, { userId: actor?.id ?? null, entity: 'loan_txn', entityId: id, action: 'create', after: { type, amount_rial: amount, date } });
    return db.get('SELECT * FROM loans WHERE id = ?', [id]);
  });
}

export function deleteFinancialTxn(db, actor, table, id, { reason } = {}) {
  const allowed = { capital_txn: 'capital_txns', loan_txn: 'loans', inventory_adjustment: 'inventory_adjustments' };
  const real = allowed[table] || table;
  if (!['capital_txns', 'loans', 'inventory_adjustments'].includes(real)) throw badRequest('جدول نامعتبر.', { field: 'table' });
  const why = V.text('reason', { required: true, maxLength: 500, label: 'دلیل حذف' })({ reason });
  return db.tx(() => {
    const before = db.get(`SELECT * FROM ${real} WHERE id = ?`, [id]);
    if (!before) throw notFound('تراکنش یافت نشد.');
    db.run(`DELETE FROM ${real} WHERE id = ?`, [id]);
    if (real !== 'capital_txns' && real !== 'loans') refreshStockCache(db);
    audit(db, { userId: actor?.id ?? null, entity: real, entityId: id, action: 'delete', before, note: why });
    return { deleted: true, id: Number(id) };
  });
}

/* ----------------------------------------------------------------- setup -- */

export function upsertOpeningBalance(db, actor, body) {
  const kind = V.oneOf('kind', ['receivable', 'payable'], { label: 'نوع مانده' })(body);
  const party = V.text('party_name', { required: true, maxLength: 120, label: 'نام طرف حساب' })(body);
  const amount = amountField(body, { tomanField: 'amount_toman', rialField: 'amount_rial', required: true, min: 10, label: 'مبلغ' });
  const date = V.date('occurred_date', { required: false, label: 'تاریخ' })(body);
  return db.tx(() => {
    const id = insert(db, 'opening_balances', {
      kind,
      party_name: party,
      party_id: kind === 'receivable' ? ensureParty(db, 'customers', party) : ensureParty(db, 'suppliers', party),
      amount_rial: amount,
      occurred_date: date,
      note: V.text('note', { maxLength: 500 })(body),
      created_at: nowIso(),
    });
    audit(db, { userId: actor?.id ?? null, entity: 'opening_balance', entityId: id, action: 'create', after: { kind, party, amount_rial: amount } });
    return db.get('SELECT * FROM opening_balances WHERE id = ?', [id]);
  });
}

export function deleteOpeningBalance(db, actor, id) {
  const before = db.get('SELECT * FROM opening_balances WHERE id = ?', [id]);
  if (!before) throw notFound('ماندهٔ بازگشایی یافت نشد.');
  db.run('DELETE FROM opening_balances WHERE id = ?', [id]);
  audit(db, { userId: actor?.id ?? null, entity: 'opening_balance', entityId: id, action: 'delete', before });
  return { deleted: true, id: Number(id) };
}

/**
 * Pin a saved FX record as the rate used for a reporting period. This is a
 * *selection*, never an edit: the historical rows stay untouched.
 */
export function chooseFxRate(db, actor, { periodType, period, fxRateId }) {
  const key = `fx_choice:${periodType}:${period}`;
  if (fxRateId === null || fxRateId === 0 || fxRateId === 'auto') {
    db.run('DELETE FROM settings WHERE key = ?', [key]);
    audit(db, { userId: actor?.id ?? null, entity: 'fx_choice', entityId: period, action: 'clear', after: { periodType, period } });
    return { ok: true, cleared: true };
  }
  const row = db.get('SELECT * FROM fx_rates WHERE id = ?', [Number(fxRateId)]);
  if (!row) throw badRequest('رکورد نرخ دلار انتخابی وجود ندارد.', { field: 'fx_rate_id' });
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, String(row.id), nowIso()],
  );
  audit(db, {
    userId: actor?.id ?? null,
    entity: 'fx_choice',
    entityId: period,
    action: 'select',
    after: { periodType, period, fx_rate_id: row.id, rate_toman_x100: row.rate_toman_x100, effective_date: row.effective_date },
  });
  return { ok: true, item: { id: row.id, effective_date: row.effective_date, rate_toman_x100: row.rate_toman_x100 } };
}

export const SETTING_KEYS = {
  business_name: { type: 'text', maxLength: 120 },
  owner_name: { type: 'text', maxLength: 120 },
  phone: { type: 'text', maxLength: 30 },
  address: { type: 'text', maxLength: 300 },
  currency_display_unit: { type: 'enum', values: ['toman', 'rial'] },
  timezone: { type: 'text', maxLength: 60 },
  opening_date: { type: 'date' },
  inflation_base_period: { type: 'jperiod' },
  default_account_id: { type: 'int' },
  show_rial_secondary: { type: 'bool' },
};

export function setSettings(db, actor, body) {
  const problems = [];
  const applied = {};
  for (const [key, rule] of Object.entries(SETTING_KEYS)) {
    if (!(key in body)) continue;
    let value = body[key];
    if (value === null) {
      db.run('DELETE FROM settings WHERE key = ?', [key]);
      applied[key] = null;
      continue;
    }
    if (rule.type === 'text') {
      const s = V.text(key, { required: true, maxLength: rule.maxLength, label: key })(body);
      value = s;
    } else if (rule.type === 'enum') {
      value = V.oneOf(key, rule.values, { label: key })(body);
    } else if (rule.type === 'bool') {
      value = value ? '1' : '0';
    } else if (rule.type === 'date') {
      value = V.date(key, { label: key, future: 'allow' })(body);
    } else if (rule.type === 'jperiod') {
      const raw = String(value).trim();
      value = raw === '' ? null : V.jperiod(key, { label: key })(body);
      if (value && !/^\d{4}-\d{2}$/.test(value)) problems.push(`${key}: باید ماه جلالی (۱۴۰۵-۰۲) باشد`);
    } else if (rule.type === 'int') {
      value = String(V.int(key, { label: key, min: 1 })(body));
      if (!db.get('SELECT id FROM accounts WHERE id = ?', [Number(value)])) problems.push(`${key}: حساب انتخابی وجود ندارد`);
    }
    if (value === null) {
      db.run('DELETE FROM settings WHERE key = ?', [key]);
      applied[key] = null;
      continue;
    }
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, String(value), nowIso()],
    );
    applied[key] = value;
  }
  if (problems.length) throw badRequest('برخی تنظیمات قابل ذخیره نیستند.', { problems });
  audit(db, { userId: actor?.id ?? null, entity: 'settings', entityId: null, action: 'update', after: applied });
  if ('inflation_base_period' in body || 'timezone' in body) refreshStockCache(db);
  return readSettings(db);
}

export function readSettings(db) {
  const out = {};
  for (const r of db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}

/* ------------------------------------------------------ report snapshots -- */

export function finalizeReport(db, actor, { periodType, period, note = null, status = 'final' }) {
  const built = periodType === 'year' ? buildYear(db, period) : buildMonth(db, period);
  const { report, bucket, ledger } = built;
  const blocking = report.dataGaps.blocking;
  if (blocking.length && status === 'final') {
    const err = conflict('ذخیرهٔ گزارش نهایی ممکن نیست: داده‌های لازم کامل نیست.', { blocking, hint: 'می‌توانید گزارش را به‌صورت پیش‌نویس (برآورد) ذخیره کنید.' });
    throw err;
  }
  const prev = db.get('SELECT * FROM report_snapshots WHERE period_type = ? AND period = ? ORDER BY version DESC LIMIT 1', [periodType, period]);
  const version = (prev?.version || 0) + 1;
  const inflation = db.all('SELECT * FROM inflation_assumptions WHERE period <= ? ORDER BY period', [periodType === 'year' ? `${period}-12` : period]);
  const payload = {
    ...report,
    real_analysis: realAnalysisFor(db, { period, periodType, report }),
    replacement_analysis: replacementFor(ledger, bucket),
    inflation_assumptions: inflation.map((r) => ({ period: r.period, rate_pct_x100: r.rate_pct_x100 })),
    snapshot_context: {
      status,
      version,
      blocking_gaps: blocking,
      finalized_by: actor?.username ?? null,
      note: note ? String(note).slice(0, 500) : null,
    },
  };
  const id = insert(db, 'report_snapshots', {
    period_type: periodType,
    period,
    version,
    status,
    payload_json: JSON.stringify(payload),
    fx_start_date: report.fx?.period?.start?.effective_date ?? null,
    fx_end_date: report.fx?.period?.end?.effective_date ?? null,
    fx_rate_end_id: report.fx?.period?.end?.id ?? null,
    fx_rate_start_id: report.fx?.period?.start?.id ?? null,
    inflation_base_period: payload.real_analysis?.base_period ?? null,
    calc_warnings_json: JSON.stringify({ warnings: report.dataGaps.warnings, blocking }),
    computed_at: report.meta.computed_at,
    created_at: nowIso(),
    created_by: actor?.id ?? null,
    note: note ? String(note).slice(0, 500) : null,
  });
  if (prev) {
    const prevPayload = safeParse(prev.payload_json);
    db.run('INSERT INTO report_corrections (snapshot_id, period_type, period, reason, user_id, created_at, diff_json) VALUES (?,?,?,?,?,?,?)', [
      id,
      periodType,
      period,
      note ? String(note).slice(0, 500) : 'بازمحاسبه پس از تغییر داده‌های گذشته',
      actor?.id ?? null,
      nowIso(),
      JSON.stringify(
        diffNumbers({
          net_sales_rial: [prevPayload?.sales?.net_rial, report.sales.net_rial],
          cogs_rial: [prevPayload?.sales?.cogs_rial, report.sales.cogs_rial],
          gross_profit_rial: [prevPayload?.profit?.gross_rial, report.profit.gross_rial],
          net_profit_rial: [prevPayload?.profit?.net_rial, report.profit.net_rial],
          inventory_closing_rial: [prevPayload?.inventory?.closing_value_rial, report.inventory.closing_value_rial],
          fx_end_rate_x100: [prevPayload?.fx?.period?.end_rate_x100, report.fx?.period?.end_rate_x100],
        }),
      ),
    ]);
    audit(db, { userId: actor?.id ?? null, entity: 'report_snapshot', entityId: id, action: 'restate', before: { version: prev.version, status: prev.status }, after: { version, status }, note });
  } else {
    audit(db, { userId: actor?.id ?? null, entity: 'report_snapshot', entityId: id, action: 'finalize', after: { periodType, period, version, status }, note });
  }
  return readSnapshot(db, id);
}

function diffNumbers(map) {
  const out = {};
  for (const [k, [before, after]] of Object.entries(map)) {
    if (before !== after) out[k] = { before: before ?? null, after: after ?? null, delta: Number.isFinite(before) && Number.isFinite(after) ? after - before : null };
  }
  return out;
}

const safeParse = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

function buildMonth(db, period) {
  const built = monthReport(db, String(period));
  if (!built) throw badRequest('دورهٔ نامعتبر است (قالب ۱۴۰۵-۰۲).', { field: 'period' });
  return built;
}

function buildYear(db, year) {
  const built = yearReport(db, String(year));
  if (!built) throw badRequest('سال نامعتبر است (قالب ۱۴۰۵).', { field: 'year' });
  return built;
}

function realAnalysisFor(db, { period, periodType, report }) {
  try {
    return realAnalysis(db, { period, granularity: periodType, reports: { current: report } });
  } catch (e) {
    return { available: false, error: String(e.message), disclaimer: 'محاسبهٔ سود واقعی ممکن نشد.' };
  }
}

function replacementFor(ledger, bucket) {
  try {
    return replacementAnalysis(ledger, bucket);
  } catch (e) {
    return { available: false, error: String(e.message) };
  }
}

/** Live report for a period (never reads a snapshot). */
export function liveReport(db, { periodType, period }) {
  const built = periodType === 'year' ? buildYear(db, period) : buildMonth(db, period);
  const report = built.report;
  report.real_analysis = realAnalysisFor(db, { period: String(period), periodType, report });
  report.replacement_analysis = replacementFor(built.ledger, built.bucket);
  report.snapshots = listSnapshots(db, { periodType, period }).map(({ id, version, status, computed_at, created_at, note }) => ({
    id,
    version,
    status,
    computed_at,
    created_at,
    note,
  }));
  return report;
}

export function liveRangeReport(db, { from, to }) {
  const built = rangeReport(db, { from, to });
  const report = built.report;
  report.real_analysis = realAnalysisFor(db, { period: gregorianToJalali(to).period, periodType: 'month', report });
  report.replacement_analysis = replacementFor(built.ledger, built.bucket);
  return report;
}

export function listSnapshots(db, { periodType = null, period = null } = {}) {
  const where = [];
  const args = [];
  if (periodType) {
    where.push('period_type = ?');
    args.push(periodType);
  }
  if (period) {
    where.push('period = ?');
    args.push(String(period));
  }
  const rows = db.all(
    `SELECT id, period_type, period, version, status, computed_at, created_at, note,
            fx_start_date, fx_end_date, inflation_base_period
       FROM report_snapshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY period DESC, version DESC`,
    args,
  );
  return rows;
}

export function readSnapshot(db, id) {
  const row = db.get('SELECT * FROM report_snapshots WHERE id = ?', [id]);
  if (!row) throw notFound('گزارش ذخیره‌شده یافت نشد.');
  const payload = safeParse(row.payload_json);
  return {
    id: row.id,
    period_type: row.period_type,
    period: row.period,
    version: row.version,
    status: row.status,
    computed_at: row.computed_at,
    created_at: row.created_at,
    note: row.note,
    fx_start_date: row.fx_start_date,
    fx_end_date: row.fx_end_date,
    inflation_base_period: row.inflation_base_period,
    warnings: safeParse(row.calc_warnings_json),
    corrections: db.all('SELECT id, reason, created_at, diff_json FROM report_corrections WHERE snapshot_id = ? OR period = ? ORDER BY id', [
      id,
      row.period,
    ]),
    report: { ...payload, meta: { ...payload.meta, source: 'snapshot', snapshot_id: row.id, snapshot_version: row.version, snapshot_status: row.status } },
  };
}

export function latestSnapshot(db, { periodType, period }) {
  const row = db.get('SELECT id FROM report_snapshots WHERE period_type = ? AND period = ? ORDER BY version DESC LIMIT 1', [periodType, String(period)]);
  return row ? readSnapshot(db, row.id) : null;
}

