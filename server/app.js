/**
 * Hyper Sina — API wiring: routing, auth gate, CSRF, rate limits, exports.
 *
 * Security model
 *  • every /api/* endpoint except login/register/bootstrap requires a session
 *    cookie (HttpOnly, SameSite=Strict) — no financial data is reachable anonymously
 *  • every mutating endpoint additionally requires the per-session CSRF token
 *    in `x-csrf-token` (double-submit) and authorises the role server-side
 *  • all business rules (units, totals, balances, stock) are re-checked here and
 *    in services.js — the client is never trusted with arithmetic
 *  • errors never leak SQL/stack details to the browser
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, badRequest, notFound, sendJson, readJson, createRouter, serveStatic, V } from './http.js';
import {
  authenticate,
  createSession,
  destroySession,
  destroyAllSessions,
  setSessionCookie,
  clearSessionCookie,
  hashPassword,
  verifyPassword,
  passwordProblems,
  requireUser,
  requireRole,
  requireCsrf,
  WRITE_ROLES,
  ADMIN_ROLES,
  throttle,
  throttleClear,
} from './auth.js';
import * as S from './services.js';
import {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  EXPENSE_LABELS,
  ADJ_REASON_LABELS,
  buildLedger,
  monthReport,
  yearReport,
  rangeReport,
  realAnalysis, fxForPeriod,
  publicFx,
  loadInflation,
} from './accounting.js';
import { shopNow, formatJalaliDate, formatJalaliPeriod, jalaliRange, jalaliMonthShift, DEFAULT_TZ } from './calendar.js';
import { QTY_SCALE, divRound, formatRial, rialToToman } from './money.js';

const nowIso = () => new Date().toISOString();
const APP_NAME = 'هایپر سینا';

export function createHandler(db, { version = '1.0.0' } = {}) {
  const router = createRouter();
  const json = (ctx, payload, status = 200) => sendJson(ctx.res, status, payload);

  /* ------------------------------------------------------------- bootstrap */
  const getSetting = (key, fallback = null) => db.get('SELECT value FROM settings WHERE key = ?', [key])?.value ?? fallback;
  const businessName = () => getSetting('business_name', APP_NAME);
  const tz = () => getSetting('timezone', DEFAULT_TZ);

  router.get('/api/bootstrap', (ctx) => {
    const userCount = db.get('SELECT COUNT(*) AS n FROM users').n;
    const user = ctx.user;
    const now = shopNow(tz());
    return json(ctx, {
      app: { name: 'Hyper Sina', display_name: APP_NAME, version },
      needs_setup: userCount === 0,
      authenticated: !!user,
      user: user ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role } : null,
      csrf: user?.csrf ?? null,
      business_name: businessName(),
      clock: {
        today: now.date,
        time: now.time,
        tz: tz(),
        jalali_today: now.jalali.date,
        today_period: now.jalali.period,
        today_period_label: formatJalaliPeriod(now.jalali.period),
        this_year: now.jalali.year,
      },
      settings: S.readSettings(db),
      counts: {
        sales: db.get('SELECT COUNT(*) AS n FROM sales').n,
        purchases: db.get('SELECT COUNT(*) AS n FROM purchases').n,
        expenses: db.get('SELECT COUNT(*) AS n FROM expenses').n,
        products: db.get('SELECT COUNT(*) AS n FROM products').n,
        fx_rates: db.get('SELECT COUNT(*) AS n FROM fx_rates').n,
        snapshots: db.get('SELECT COUNT(*) AS n FROM report_snapshots').n,
      },
      expense_categories: EXPENSE_CATEGORIES,
      payment_methods: PAYMENT_METHODS,
      adjustment_reasons: ADJ_REASON_LABELS,
    });
  });

  /* ------------------------------------------------------------------ auth */
  router.post('/api/auth/register', async (ctx) => {
    const body = await readJson(ctx.req);
    if (db.get('SELECT COUNT(*) AS n FROM users').n > 0) throw new HttpError(403, 'حساب کاربری ساخته شده است. لطفاً وارد شوید.');
    const username = V.text('username', { required: true, maxLength: 40, label: 'نام کاربری' })(body).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw badRequest('نام کاربری باید ۳ تا ۴۰ نویسه (حروف کوچک انگلیسی، عدد، . _ -) باشد.', { field: 'username' });
    const password = String(body.password ?? '');
    const problem = passwordProblems(password, username);
    if (problem) throw badRequest(problem, { field: 'password' });
    const displayName = V.text('display_name', { maxLength: 60, label: 'نام نمایشی' })(body) || username;
    return db.tx(() => {
      const id = db.run('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)', [
        username,
        hashPassword(password),
        displayName,
        'owner',
        nowIso(),
      ]).lastInsertRowid;
      const user = db.get('SELECT * FROM users WHERE id = ?', [id]);
      const { token, csrf } = createSession(db, user, { userAgent: ctx.req.headers['user-agent'] || '' });
      setSessionCookie(ctx.res, token, { secure: ctx.secure });
      return json(ctx, { ok: true, csrf, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } }, 201);
    });
  });

  router.post('/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const username = String(body.username ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const ip = ctx.ip;
    throttle(`login:${ip}:${username}`, { max: 8, windowMs: 10 * 60 * 1000 });
    const user = username ? db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]) : null;
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'نام کاربری یا رمز عبور اشتباه است.');
    }
    throttleClear(`login:${ip}:${username}`);
    db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
    const { token, csrf } = createSession(db, user, { userAgent: ctx.req.headers['user-agent'] || '' });
    setSessionCookie(ctx.res, token, { secure: ctx.secure });
    S.audit(db, { userId: user.id, entity: 'session', entityId: user.id, action: 'login' });
    return json(ctx, { ok: true, csrf, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
  });

  router.post('/api/auth/logout', (ctx) => {
    if (ctx.user) {
      destroySession(db, ctx.token);
      S.audit(db, { userId: ctx.user.id, entity: 'session', entityId: ctx.user.id, action: 'logout' });
    }
    clearSessionCookie(ctx.res);
    return json(ctx, { ok: true });
  });

  router.post('/api/auth/password', async (ctx) => {
    const user = requireRole(ctx, ...ADMIN_ROLES);
    const body = await readJson(ctx.req);
    requireCsrf(ctx);
    const current = String(body.current_password ?? '');
    const next = String(body.new_password ?? '');
    const row = db.get('SELECT * FROM users WHERE id = ?', [user.id]);
    if (!verifyPassword(current, row.password_hash)) throw badRequest('رمز عبور فعلی اشتباه است.', { field: 'current_password' });
    const problem = passwordProblems(next, row.username);
    if (problem) throw badRequest(problem, { field: 'new_password' });
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(next), user.id]);
    destroyAllSessions(db, user.id);
    clearSessionCookie(ctx.res);
    S.audit(db, { userId: user.id, entity: 'user', entityId: user.id, action: 'password-change' });
    return json(ctx, { ok: true, message: 'رمز عبور تغییر کرد. همهٔ دستگاه‌ها خارج شدند؛ دوباره وارد شوید.' });
  });

  /* ------------------------------------------------------------ FX + rate -- */
  router.get('/api/fx', (ctx) => {
    requireUser(ctx);
    const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 120, 1000);
    const rows = db.all('SELECT * FROM fx_rates ORDER BY effective_date DESC LIMIT ?', [limit]);
    // Explicit dates win; otherwise the shared period selector decides the window,
    // so "average of the rates I recorded this month" always means the visible period.
    const explicit = ctx.url.searchParams.get('from') || ctx.url.searchParams.get('to');
    const range = explicit ? { from: ctx.url.searchParams.get('from'), to: ctx.url.searchParams.get('to') } : rangeParams(ctx, tz());
    const { from, to } = range;
    return json(ctx, {
      items: rows.map(publicFx),
      series: db
        .all('SELECT effective_date, rate_toman_x100 FROM fx_rates ORDER BY effective_date ASC LIMIT 2000')
        .map((r) => ({ date: r.effective_date, rate_toman_x100: r.rate_toman_x100 })),
      summary: fxForPeriod(db, { from, to }),
      note: 'همهٔ نرخ‌ها دستی وارد شده‌اند. این برنامه هیچ نرخی را از بیرون نمی‌گیرد یا حدس نمی‌زند.',
    });
  });

  router.post('/api/fx', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const row = S.upsertFxRate(db, ctx.user, body);
    return json(ctx, { ok: true, item: row, message: 'نرخ دلار ذخیره شد.' }, 201);
  });

  router.post('/api/fx/choice', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const periodType = body.period_type === 'year' ? 'year' : 'month';
    const period = periodType === 'year' ? normalizeYear(body.period) : normalizePeriod(body.period);
    const out = S.chooseFxRate(db, ctx.user, { periodType, period, fxRateId: body.fx_rate_id });
    return json(ctx, { ...out, message: out.cleared ? 'انتخاب دستی لغو شد؛ نرخ انتهای دوره دوباره خودکار تعیین می‌شود.' : 'این رکورد به‌عنوان نرخ دلار این دورهٔ گزارش انتخاب شد.' });
  });

  router.get('/api/inflation', (ctx) => {
    requireUser(ctx);
    return json(ctx, {
      items: db.all('SELECT * FROM inflation_assumptions ORDER BY period DESC').map((r) => ({
        period: r.period,
        label: formatJalaliPeriod(r.period),
        rate_pct_x100: r.rate_pct_x100,
        note: r.note,
        updated_at: r.updated_at,
      })),
      base_period: getSetting('inflation_base_period'),
      disclaimer: 'این اعداد فرض واردشده توسط شماست، نه نرخ رسمی تورم.',
    });
  });

  router.post('/api/inflation', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const row = S.upsertInflation(db, ctx.user, body);
    return json(ctx, { ok: true, item: row, message: 'فرض تورم ذخیره شد.' }, 201);
  });

  router.del('/api/inflation/:period', (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    return json(ctx, { ok: true, ...S.deleteInflation(db, ctx.user, ctx.params.period) });
  });

  /* ----------------------------------------------------------- dashboard -- */
  router.get('/api/dashboard', (ctx) => {
    requireUser(ctx);
    const now = shopNow(tz());
    const period = getSetting('report_period');
    const today = now.date;
    const monthPeriod = now.jalali.period;
    const prevPeriod = formatPrevPeriod(monthPeriod);
    const year = now.jalali.year;
    const month = monthReport(db, monthPeriod).report;
    const prev = monthReport(db, prevPeriod).report;
    const yearly = yearReport(db, year).report;
    const todayReport = rangeReport(db, { from: today, to: today }).report;
    const fx = fxForPeriod(db, { from: month.meta.from_date, to: today });
    const accounts = db.all('SELECT * FROM accounts WHERE archived = 0 ORDER BY id');
    const trend = [];
    for (let i = 5; i >= 0; i -= 1) {
      const p = shiftPeriod(monthPeriod, -i);
      const r = monthReport(db, p).report;
      trend.push({
        period: p,
        label: formatJalaliPeriod(p, { digits: 'fa' }),
        net_sales_rial: r.sales.net_rial,
        gross_rial: r.profit.gross_rial,
        net_rial: r.profit.net_rial,
        expenses_rial: r.expenses.total_rial,
        fx_end_rate_x100: r.fx?.period?.end_rate_x100 ?? null,
      });
    }
    const quick = {
      recent_sales: db.all(
        `SELECT s.id, s.txn_date, s.occurred_at, s.customer_name, s.payment_method, s.amount_received_rial, s.header_discount_rial,
                (SELECT COALESCE(SUM(CASE WHEN l.kind='return' THEN -1 ELSE 1 END * (l.line_total_rial - l.discount_rial)),0)
                   FROM sale_lines l WHERE l.sale_id = s.id) - s.header_discount_rial AS total_rial
           FROM sales s ORDER BY s.txn_date DESC, s.id DESC LIMIT 6`,
      ),
      recent_expenses: db.all('SELECT id, expense_date, category, amount_rial, note FROM expenses ORDER BY expense_date DESC, id DESC LIMIT 6'),
    };
    return json(ctx, {
      business_name: businessName(),
      today,
      today_label: formatJalaliDate(today, { digits: 'fa' }),
      period: monthPeriod,
      period_label: formatJalaliPeriod(monthPeriod),
      today_report: todayReport,
      month_report: month,
      previous_month_report: { period: prevPeriod, label: formatJalaliPeriod(prevPeriod), net_rial: prev.profit.net_rial, net_sales_rial: prev.sales.net_rial },
      year_report: {
        period,
        net_rial: yearly.profit.net_rial,
        net_sales_rial: yearly.sales.net_rial,
        gross_rial: yearly.profit.gross_rial,
        operating_rial: yearly.profit.operating_rial,
        expenses_rial: yearly.expenses.total_rial,
        cash_net_rial: yearly.cash.net_rial,
        label: `سال ${year.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d])}`,
      },
      fx,
      trend,
      accounts,
      quick,
      alerts: buildAlerts(month, yearly, fx, accounts, db),
    });
  });

  /* --------------------------------------------------------- sales module */
  router.get('/api/sales', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 50, 300);
    const offset = Math.max(Number(ctx.url.searchParams.get('offset')) || 0, 0);
    const where = ['txn_date BETWEEN ? AND ?'];
    const args = [from, to];
    const q = (ctx.url.searchParams.get('q') || '').trim();
    if (q) {
      where.push('(customer_name LIKE ? OR note LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    const rows = db.all(
      `SELECT s.*,
              (SELECT COALESCE(SUM(CASE WHEN l.kind='return' THEN -1 ELSE 1 END * (l.line_total_rial - l.discount_rial)),0)
                 FROM sale_lines l WHERE l.sale_id = s.id) - s.header_discount_rial AS total_rial,
              (SELECT COALESCE(SUM(l.cogs_rial),0) FROM sale_lines l WHERE l.sale_id = s.id AND l.kind='sale') AS cogs_rial,
              (SELECT COUNT(*) FROM sale_lines l WHERE l.sale_id = s.id) AS line_count
         FROM sales s WHERE ${where.join(' AND ')} ORDER BY s.txn_date DESC, s.id DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    for (const r of rows) r.outstanding_rial = r.total_rial - r.amount_received_rial;
    const totals = db.get(
      `SELECT COUNT(*) AS invoices,
              COALESCE(SUM(total),0) AS net_rial,
              COALESCE(SUM(amount_received_rial),0) AS received_rial
         FROM (SELECT s.amount_received_rial,
               (SELECT COALESCE(SUM(CASE WHEN l.kind='return' THEN -1 ELSE 1 END * (l.line_total_rial - l.discount_rial)),0)
                  FROM sale_lines l WHERE l.sale_id = s.id) - s.header_discount_rial AS total
            FROM sales s WHERE ${where.join(' AND ')})`,
      args,
    );
    return json(ctx, { items: rows, totals, from, to, limit, offset });
  });

  router.get('/api/sales/:id', (ctx) => {
    requireUser(ctx);
    return json(ctx, S.readSale(db, Number(ctx.params.id)));
  });

  router.post('/api/sales', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const sale = S.createSale(db, ctx.user, body);
    return json(ctx, { ok: true, item: sale, message: `فروش به مبلغ ${formatRial(sale.computed.total_rial)} ثبت شد.` }, 201);
  });

  router.put('/api/sales/:id', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    if (!body.reason) throw badRequest('برای ویرایش فاکتور فروش، دلیل ویرایش الزامی است (ثبت در سابقهٔ تغییرات).', { field: 'reason' });
    const sale = S.updateSale(db, ctx.user, Number(ctx.params.id), body);
    return json(ctx, { ok: true, item: sale, message: 'فروش به‌روزرسانی شد.' });
  });

  router.del('/api/sales/:id', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    const out = S.deleteSale(db, ctx.user, Number(ctx.params.id), { reason: body.reason });
    return json(ctx, { ...out, message: 'فروش حذف شد و گزارش‌ها بازمحاسبه گردید.' });
  });

  /* ----------------------------------------------------- purchases module */
  router.get('/api/purchases', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    const rows = db.all(
      `SELECT p.*,
              (SELECT COALESCE(SUM(l.line_total_rial),0) FROM purchase_lines l WHERE l.purchase_id = p.id) AS goods_cost_rial,
              (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count
         FROM purchases p WHERE p.purchase_date BETWEEN ? AND ? ORDER BY p.purchase_date DESC, p.id DESC LIMIT 200`,
      [from, to],
    );
    for (const r of rows) {
      r.total_rial = r.goods_cost_rial + r.extra_cost_rial;
      r.outstanding_rial = r.total_rial - r.amount_paid_rial;
    }
    return json(ctx, { items: rows, from, to });
  });

  router.get('/api/purchases/:id', (ctx) => json(ctx, S.readPurchase(db, Number(ctx.params.id))));

  router.post('/api/purchases', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const p = S.createPurchase(db, ctx.user, body);
    return json(ctx, { ok: true, item: p, message: `خرید به مبلغ ${formatRial(p.computed.total_rial)} ثبت شد و به موجودی اضافه شد.` }, 201);
  });

  router.put('/api/purchases/:id', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    if (!body.reason) throw badRequest('برای ویرایش فاکتور خرید، دلیل ویرایش الزامی است.', { field: 'reason' });
    return json(ctx, { ok: true, item: S.updatePurchase(db, ctx.user, Number(ctx.params.id), body), message: 'خرید به‌روزرسانی شد.' });
  });

  router.del('/api/purchases/:id', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    return json(ctx, { ...S.deletePurchase(db, ctx.user, Number(ctx.params.id), { reason: body.reason }), message: 'خرید حذف شد.' });
  });

  /* --------------------------------------------------------- products ---- */
  router.get('/api/products', (ctx) => {
    requireUser(ctx);
    const includeInactive = ctx.url.searchParams.get('include_inactive') === '1';
    const items = db.all(
      `SELECT p.*,
              (SELECT COALESCE(SUM(l.qty_x1000),0) FROM sale_lines l JOIN sales s ON s.id = l.sale_id
                 WHERE l.product_id = p.id AND s.txn_date BETWEEN ? AND ? AND l.kind='sale') AS sold_qty_x1000,
              (SELECT l2.unit_price_rial FROM sale_lines l2 JOIN sales s2 ON s2.id = l2.sale_id
                 WHERE l2.product_id = p.id AND l2.kind='sale' ORDER BY s2.txn_date DESC, l2.id DESC LIMIT 1) AS last_price_rial,
              (SELECT s3.txn_date FROM sale_lines l3 JOIN sales s3 ON s3.id = l3.sale_id
                 WHERE l3.product_id = p.id AND l3.kind='sale' ORDER BY s3.txn_date DESC, l3.id DESC LIMIT 1) AS last_price_date
         FROM products p ${includeInactive ? '' : 'WHERE p.active = 1'} ORDER BY p.name`,
      [getSetting('opening_date') || '1800-01-01', '2999-12-31'],
    );
    for (const p of items) {
      // same half-away-from-zero BigInt rule as the ledger, so the list and the
      // reports never disagree by one rial
      p.avg_unit_cost_rial =
        p.stock_qty_x1000 > 0 ? Number(divRound(BigInt(p.stock_cost_rial) * 1000n, BigInt(p.stock_qty_x1000))) : p.last_avg_cost_rial || 0;
      p.replacement_margin_rial =
        p.replacement_unit_cost_rial && p.avg_unit_cost_rial ? p.replacement_unit_cost_rial - p.avg_unit_cost_rial : null;
    }
    return json(ctx, {
      items,
      totals: {
        inventory_value_rial: items.reduce((a, p) => a + p.stock_cost_rial, 0),
        items: items.length,
        negative: items.filter((p) => p.stock_qty_x1000 < 0).length,
      },
    });
  });

  router.post('/api/products', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    return json(ctx, { ok: true, item: S.createProduct(db, ctx.user, body), message: 'کالا/خدمت ثبت شد.' }, 201);
  });

  router.put('/api/products/:id', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    return json(ctx, { ok: true, item: S.updateProduct(db, ctx.user, Number(ctx.params.id), body), message: 'کالا/خدمت به‌روزرسانی شد.' });
  });

  router.del('/api/products/:id', (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    return json(ctx, { ...S.deleteProduct(db, ctx.user, Number(ctx.params.id)), message: 'کالا حذف شد.' });
  });

  router.get('/api/inventory/adjustments', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    return json(ctx, {
      items: db.all(
        `SELECT a.*, p.name AS product_name FROM inventory_adjustments a JOIN products p ON p.id = a.product_id
          WHERE a.txn_date BETWEEN ? AND ? ORDER BY a.txn_date DESC, a.id DESC LIMIT 200`,
        [from, to],
      ),
    });
  });

  router.post('/api/inventory/adjustments', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    return json(ctx, { ok: true, item: S.createAdjustment(db, ctx.user, body), message: 'اصلاح موجودی ثبت شد.' }, 201);
  });

  /* -------------------------------------------------------- expenses ----- */
  router.get('/api/expenses', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    const items = db.all('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC LIMIT 300', [from, to]);
    for (const e of items) {
      const paid = e.amount_paid_rial === null ? e.amount_rial : e.amount_paid_rial;
      e.paid_rial = paid;
      e.outstanding_rial = e.amount_rial - paid;
      e.category_label = EXPENSE_LABELS[e.category];
    }
    const byCategory = {};
    for (const e of items) byCategory[e.category] = (byCategory[e.category] || 0) + e.amount_rial;
    return json(ctx, { items, totals: { count: items.length, amount_rial: items.reduce((a, e) => a + e.amount_rial, 0), byCategory }, from, to });
  });

  router.post('/api/expenses', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const out = S.createExpense(db, ctx.user, body);
    return json(ctx, { ok: true, item: out, message: `هزینهٔ ${formatRial(out.amount_rial)} ثبت شد.` }, 201);
  });

  router.put('/api/expenses/:id', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    if (!body.reason) throw badRequest('برای ویرایش هزینه، دلیل ویرایش الزامی است.', { field: 'reason' });
    return json(ctx, { ok: true, item: S.updateExpense(db, ctx.user, Number(ctx.params.id), body), message: 'هزینه به‌روزرسانی شد.' });
  });

  router.del('/api/expenses/:id', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    return json(ctx, { ...S.deleteExpense(db, ctx.user, Number(ctx.params.id), { reason: body.reason }), message: 'هزینه حذف شد.' });
  });

  /* -------------------------------------------- accounts / settlements ---- */
  router.get('/api/accounts', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    const accounts = db.all('SELECT * FROM accounts ORDER BY archived, id');
    const ledger = buildLedger(db);
    const current = ledger.finalSnapshot;
    const opening = buildLedger(db, { to: previousDay(from) }).finalSnapshot;
    const movements = [];
    for (const r of db.all(
      `SELECT 'sale' AS src, id AS ref_id, txn_date AS d, account_id, amount_received_rial AS amt, 'واریز فروش' AS label FROM sales
        WHERE txn_date BETWEEN ? AND ? AND amount_received_rial > 0
        UNION ALL SELECT 'expense', id, expense_date, account_id, -amount_rial, 'هزینه' FROM expenses WHERE expense_date BETWEEN ? AND ?
        UNION ALL SELECT 'purchase', id, purchase_date, account_id, -amount_paid_rial, 'پرداخت خرید' FROM purchases
          WHERE purchase_date BETWEEN ? AND ? AND amount_paid_rial > 0
        UNION ALL SELECT 'settlement', id, txn_date, account_id,
          CASE WHEN type='customer_receipt' THEN amount_rial ELSE -amount_rial END,
          CASE WHEN type='customer_receipt' THEN 'وصول مطالبات' ELSE 'پرداخت به تأمین‌کننده' END
          FROM settlements WHERE txn_date BETWEEN ? AND ?
        UNION ALL SELECT 'capital', id, txn_date, account_id,
          CASE WHEN type='deposit' THEN amount_rial ELSE -amount_rial END,
          CASE WHEN type='deposit' THEN 'وارسه سرمایه' ELSE 'برداشت سرمایه' END
          FROM capital_txns WHERE txn_date BETWEEN ? AND ?
        UNION ALL SELECT 'loan', id, txn_date, account_id,
          CASE WHEN type='loan_in' THEN amount_rial ELSE -amount_rial END,
          CASE WHEN type='loan_in' THEN 'دریافت وام' WHEN type='loan_repayment' THEN 'قسط وام' ELSE 'بهرهٔ وام' END
          FROM loans WHERE txn_date BETWEEN ? AND ?
        ORDER BY d, src, ref_id`,
      [from, to, from, to, from, to, from, to, from, to, from, to],
    )) {
      if (!r.account_id) continue;
      const acc = accounts.find((a) => a.id === r.account_id);
      movements.push({ ...r, account_name: acc?.name || '—' });
    }
    return json(ctx, {
      items: accounts.map((a) => ({
        ...a,
        opening_period_rial: opening.cash.get(a.id) ?? a.opening_balance_rial,
        closing_rial: current.cash.get(a.id) ?? a.opening_balance_rial,
        movements: movements.filter((m) => m.account_id === a.id).length,
      })),
      movements: movements.reverse(),
      unassigned_rial: current.cash.get('unassigned') ?? 0,
      from,
      to,
      receivables: current.receivables + (current.carried?.receivables || 0),
      payables: current.payables + (current.carried?.payables || 0),
    });
  });

  router.post('/api/accounts', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    return json(ctx, { ok: true, item: S.createAccount(db, ctx.user, body), message: 'حساب ساخته شد.' }, 201);
  });

  router.put('/api/accounts/:id', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    return json(ctx, { ok: true, item: S.updateAccount(db, ctx.user, Number(ctx.params.id), body), message: 'حساب به‌روزرسانی شد.' });
  });

  router.post('/api/settlements', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const out = S.createSettlement(db, ctx.user, body);
    return json(ctx, { ok: true, item: out, message: out.type === 'customer_receipt' ? 'وصول مطالبات ثبت شد.' : 'پرداخت به تأمین‌کننده ثبت شد.' }, 201);
  });

  router.get('/api/settlements', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    return json(ctx, {
      items: db.all(
        `SELECT s.*, c.name AS customer_name, p.name AS supplier_name
           FROM settlements s
           LEFT JOIN customers c ON c.id = s.customer_id
           LEFT JOIN suppliers p ON p.id = s.supplier_id
          WHERE s.txn_date BETWEEN ? AND ? ORDER BY s.txn_date DESC, s.id DESC LIMIT 300`,
        [from, to],
      ),
      from,
      to,
    });
  });

  router.del('/api/settlements/:id', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    return json(ctx, { ...S.deleteSettlement(db, ctx.user, Number(ctx.params.id), { reason: body.reason }), message: 'تسویه حذف شد.' });
  });

  router.post('/api/capital', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    return json(ctx, { ok: true, item: S.createCapitalTxn(db, ctx.user, body), message: 'تراکنش سرمایه ثبت شد (به‌عنوان درآمد یا هزینه حساب نمی‌شود).' }, 201);
  });

  router.post('/api/loans', async (ctx) => {
    requireRole(ctx, ...WRITE_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const item = S.createLoanTxn(db, ctx.user, body);
    const note =
      item.type === 'loan_interest' ? 'بهرهٔ وام به‌عنوان بار مالی در سود خالص اعمال شد.' : 'اصل وام/قسط تنها نقدینگی و بدهی را تغییر می‌دهد و هزینه محسوب نمی‌شود.';
    return json(ctx, { ok: true, item, message: note }, 201);
  });

  router.get('/api/financials', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    return json(ctx, {
      capital: db.all('SELECT * FROM capital_txns WHERE txn_date BETWEEN ? AND ? ORDER BY txn_date DESC, id DESC LIMIT 200', [from, to]),
      loans: db.all('SELECT * FROM loans WHERE txn_date BETWEEN ? AND ? ORDER BY txn_date DESC, id DESC LIMIT 200', [from, to]),
      loans_outstanding: db.get(
        `SELECT COALESCE(SUM(CASE WHEN type='loan_in' THEN amount_rial ELSE -amount_rial END),0) AS n
           FROM loans WHERE type IN ('loan_in','loan_repayment') AND txn_date <= ?`,
        [to],
      ).n,
      opening_balances: db.all('SELECT * FROM opening_balances ORDER BY id DESC'),
      from,
      to,
    });
  });

  router.del('/api/capital/:id', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    return json(ctx, S.deleteFinancialTxn(db, ctx.user, 'capital_txns', Number(ctx.params.id), { reason: body.reason }));
  });

  router.del('/api/loans/:id', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    return json(ctx, S.deleteFinancialTxn(db, ctx.user, 'loans', Number(ctx.params.id), { reason: body.reason }));
  });

  router.post('/api/opening-balances', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    return json(ctx, { ok: true, item: S.upsertOpeningBalance(db, ctx.user, body), message: 'ماندهٔ بازگشایی ثبت شد.' }, 201);
  });

  router.del('/api/opening-balances/:id', (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    return json(ctx, S.deleteOpeningBalance(db, ctx.user, Number(ctx.params.id)));
  });

  /* ------------------------------------------------------------- reports -- */
  router.get('/api/reports', (ctx) => {
    requireUser(ctx);
    return json(ctx, {
      months: db.all(
        `SELECT jperiod AS period, COUNT(*) AS invoices FROM sales GROUP BY jperiod
         UNION ALL SELECT jperiod, 0 FROM purchases GROUP BY jperiod
         UNION ALL SELECT jperiod, 0 FROM expenses GROUP BY jperiod ORDER BY period DESC`,
      ).map((r) => ({ period: r.period, label: formatJalaliPeriod(r.period), invoices: r.invoices })),
      snapshots: S.listSnapshots(db, {}),
    });
  });

  router.get('/api/reports/monthly/:period', (ctx) => {
    requireUser(ctx);
    const period = normalizePeriod(ctx.params.period);
    const asOf = ctx.url.searchParams.get('as_of');
    if (asOf === 'snapshot' || asOf === 'latest') {
      const snap = S.latestSnapshot(db, { periodType: 'month', period });
      if (!snap) throw notFound('برای این دوره گزارش ذخیره‌شده‌ای وجود ندارد.');
      return json(ctx, { ...snap, live: null });
    }
    const report = S.liveReport(db, { periodType: 'month', period });
    const snap = S.latestSnapshot(db, { periodType: 'month', period });
    return json(ctx, {
      report,
      label: formatJalaliPeriod(period),
      snapshot: snap
        ? {
            id: snap.id,
            version: snap.version,
            status: snap.status,
            computed_at: snap.computed_at,
            note: snap.note,
            fx_end_date: snap.fx_end_date,
            fx_start_date: snap.fx_start_date,
            inflation_base_period: snap.inflation_base_period,
            differences: snapshotDifferences(snap.report, report),
          }
        : null,
    });
  });

  router.get('/api/reports/yearly/:year', (ctx) => {
    requireUser(ctx);
    const year = normalizeYear(ctx.params.year);
    const { report } = yearReport(db, year);
    const current = Number(shopNow(tz()).jalali.year);
    const previous = yearReport(db, String(Number(year) - 1)).report;
    const hasPrev = Number(year) - 1 >= 1000 && (previous.sales.net_rial !== 0 || previous.expenses.total_rial !== 0);
    report.real_analysis = realAnalysis(db, { period: year, granularity: 'year', reports: { current: report } });
    return json(ctx, {
      report,
      year,
      is_current_year: String(year) === String(current),
      previous_year: hasPrev
        ? {
            year: String(Number(year) - 1),
            net_sales_rial: previous.sales.net_rial,
            net_profit_rial: previous.profit.net_rial,
            growth_pct_x100: previous.profit.net_rial ? Math.round(((report.profit.net_rial - previous.profit.net_rial) / Math.abs(previous.profit.net_rial)) * 10000) : null,
          }
        : null,
      snapshots: S.listSnapshots(db, { periodType: 'year', period: year }),
    });
  });

  router.get('/api/reports/range', (ctx) => {
    requireUser(ctx);
    const { from, to } = rangeParams(ctx, tz());
    return json(ctx, S.liveRangeReport(db, { from, to }));
  });

  const finalizeRoute = (periodType, param) =>
    router.post(`/api/reports/${periodType === 'month' ? 'monthly' : 'yearly'}/:${param}/finalize`, async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
      const body = await readJson(ctx.req).catch(() => ({}));
      const period = periodType === 'year' ? normalizeYear(ctx.params[param]) : normalizePeriod(ctx.params[param]);
      const status = body.status === 'draft' || body.draft ? 'draft' : 'final';
      const snap = S.finalizeReport(db, ctx.user, { periodType, period, note: body.note || null, status });
      return json(ctx, {
        ok: true,
        snapshot: snap,
        message: status === 'final' ? 'گزارش دوره بسته و به‌صورت ثابت ذخیره شد.' : 'گزارش به‌صورت پیش‌نویس (برآورد) ذخیره شد.',
      }, 201);
    });
  finalizeRoute('month', 'period');
  finalizeRoute('year', 'year');

  router.post('/api/snapshots/:id/recalculate', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    const reason = V.text('reason', { required: true, maxLength: 400, label: 'دلیل بازمحاسبه' })(body);
    const snap = S.readSnapshot(db, Number(ctx.params.id));
    const out = S.finalizeReport(db, ctx.user, { periodType: snap.period_type, period: snap.period, note: `بازمحاسبه: ${reason}`, status: 'restated' });
    return json(ctx, { ok: true, snapshot: out, message: 'نسخهٔ جدید گزارش با ثبت دلیل بازمحاسبه ساخته شد؛ نسخهٔ قبلی دست‌نخورده باقی می‌ماند.' }, 201);
  });

  router.get('/api/snapshots', (ctx) => {
    requireUser(ctx);
    return json(ctx, { items: S.listSnapshots(db, {}) });
  });

  router.get('/api/snapshots/:id', (ctx) => {
    requireUser(ctx);
    return json(ctx, S.readSnapshot(db, Number(ctx.params.id)));
  });

  /* ------------------------------- سود واقعی و اثر تورم (real profit) --- */
  router.get('/api/real-profit', (ctx) => {
    requireUser(ctx);
    const now = shopNow(tz());
    const period = normalizePeriod(ctx.url.searchParams.get('period') || now.jalali.period);
    const prevPeriod = jalaliMonthShift(period, -1);
    const cur = S.liveReport(db, { periodType: 'month', period });
    const prv = S.liveReport(db, { periodType: 'month', period: prevPeriod });
    const factor = cur.real_analysis?.cumulative_factor_x1e6 || null;
    const deflatedCur = factor ? Math.round((cur.profit.net_rial * 1_000_000) / factor) : null;
    const deflatedPrvCash = factor ? Math.round((cur.cash.closing_rial * 1_000_000) / factor) : null;
    return json(ctx, {
      period,
      label: formatJalaliPeriod(period),
      previous_period: prevPeriod,
      previous_label: formatJalaliPeriod(prevPeriod),
      disclaimer:
        'ستون «واقعی» فقط یک برآورد است که بر پایهٔ فرض تورم واردشده توسط خود شما محاسبه شده و نرخ رسمی تورم کشور نیست. تغییر نرخ دلار با نرخ تورم دو شاخص جدا هستند.',
      nominal: {
        current_net_rial: cur.profit.net_rial,
        previous_net_rial: prv.profit.net_rial,
        change_rial: cur.profit.net_rial - prv.profit.net_rial,
        change_pct_x100: prv.profit.net_rial ? Math.round(((cur.profit.net_rial - prv.profit.net_rial) / Math.abs(prv.profit.net_rial)) * 10000) : null,
        current_sales_rial: cur.sales.net_rial,
        previous_sales_rial: prv.sales.net_rial,
      },
      real: {
        available: !!cur.real_analysis?.available,
        base_period: cur.real_analysis?.base_period ?? null,
        cumulative_factor_x1e6: factor,
        missing_periods: cur.real_analysis?.missing_periods ?? [],
        current_net_rial: deflatedCur,
        purchasing_power_change_pct_x100:
          deflatedCur !== null && cur.profit.net_rial ? Math.round(((deflatedCur - cur.profit.net_rial) / Math.abs(cur.profit.net_rial)) * 10000) : null,
        cash_closing_rial: cur.cash.closing_rial,
        cash_real_rial: deflatedPrvCash,
        inventory_closing_rial: cur.inventory.closing_value_rial,
        inventory_real_rial: factor ? Math.round((cur.inventory.closing_value_rial * 1_000_000) / factor) : null,
      },
      replacement: cur.replacement_analysis,
      inflation: {
        base_period: cur.real_analysis?.base_period ?? null,
        items: db
          .all('SELECT period, rate_pct_x100, note, updated_at FROM inflation_assumptions ORDER BY period DESC LIMIT 36')
          .map((r) => ({ ...r, label: formatJalaliPeriod(r.period) })),
      },
      fx: cur.fx,
      monthly_trend: [0, 1, 2, 3, 4, 5]
        .map((i) => jalaliMonthShift(period, -i))
        .reverse()
        .map((p) => {
          const r = monthReport(db, p).report;
          return {
            period: p,
            label: formatJalaliPeriod(p),
            nominal_net_rial: r.profit.net_rial,
            net_sales_rial: r.sales.net_rial,
            fx_end_rate_x100: r.fx?.period?.end_rate_x100 ?? null,
            inflation_pct_x100: loadInflation(db).get(p)?.rate_pct_x100 ?? null,
          };
        }),
    });
  });

  router.get('/api/health', (ctx) => {
    return json(ctx, {
      ok: true,
      app: 'hyper-sina',
      version,
      node: process.version,
      db: db.driver,
      time: nowIso(),
    });
  });

  /* --------------------------------------------------- settings & profile - */
  router.get('/api/settings', (ctx) => {
    requireUser(ctx);
    return json(ctx, {
      settings: S.readSettings(db),
      users: db.all('SELECT id, username, display_name, role, created_at, last_login_at FROM users ORDER BY id').map((u) => ({ ...u, password_hash: undefined })),
      accounts: db.all('SELECT * FROM accounts ORDER BY id'),
      products_count: db.get('SELECT COUNT(*) AS n FROM products').n,
      fx_records: db.get('SELECT COUNT(*) AS n FROM fx_rates').n,
      inflation_records: db.get('SELECT COUNT(*) AS n FROM inflation_assumptions').n,
      tz: tz(),
      today: shopNow(tz()).date,
      db: db.driver,
      db_persisted: !db.readonly,
    });
  });

  router.put('/api/settings', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    const out = S.setSettings(db, ctx.user, body);
    return json(ctx, { ok: true, settings: out, message: 'تنظیمات ذخیره شد.' });
  });

  router.get('/api/audit', (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    const limit = Math.min(Number(ctx.url.searchParams.get('limit')) || 100, 500);
    return json(ctx, {
      items: db.all(
        `SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.id DESC LIMIT ?`,
        [limit],
      ),
    });
  });

  /* ---------------------------------------------------- backup & exports -- */
  router.get('/api/export.json', (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    const tables = ['settings', 'users_safe', 'fx_rates', 'inflation_assumptions', 'accounts', 'products', 'customers', 'suppliers', 'sales', 'sale_lines', 'purchases', 'purchase_lines', 'expenses', 'inventory_adjustments', 'capital_txns', 'loans', 'settlements', 'opening_balances', 'report_snapshots', 'report_corrections', 'audit_log'];
    const dump = { app: 'hyper-sina', version, exported_at: nowIso(), business_name: businessName(), tables: {} };
    for (const t of tables) {
      if (t === 'users_safe') {
        dump.tables.users = db.all('SELECT id, username, display_name, role, created_at, last_login_at FROM users');
        continue;
      }
      dump.tables[t] = db.all(`SELECT * FROM ${t}`);
    }
    const body = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
    ctx.res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="hyper-sina-backup-${shopNow(tz()).date}.json"`,
      'content-length': body.length,
    });
    ctx.res.end(body);
  });

  router.get('/api/export.csv', (ctx) => {
    requireUser(ctx);
    const what = ctx.url.searchParams.get('table') || 'sales';
    const { from, to } = rangeParams(ctx, tz());
    const csv = buildCsv(db, what, { from, to, businessName });
    const body = Buffer.from('\ufeff' + csv, 'utf8'); // BOM so Excel opens Persian correctly
    ctx.res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="hyper-sina-${what}-${from}_${to}.csv"`,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    ctx.res.end(body);
  });

  router.post('/api/reset-preview', (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const ledger = buildLedger(db);
    return json(ctx, {
      rows: Object.fromEntries(
        [
          ['sales', db.get('SELECT COUNT(*) n FROM sales').n],
          ['purchases', db.get('SELECT COUNT(*) n FROM purchases').n],
          ['expenses', db.get('SELECT COUNT(*) n FROM expenses').n],
          ['snapshots', db.get('SELECT COUNT(*) n FROM report_snapshots').n],
        ].map(([k, v]) => [k, v]),
      ),
      note: 'این برنامه هیچ داده‌ای را بدون تأیید صریح پاک نمی‌کند. برای پاک‌سازی کامل، از طریق رابط کاربری عبارت «پاک کن» را تایپ کنید.',
      inventory_value_rial: ledger.finalSnapshot.inventoryValue,
      cash_total_rial: ledger.finalSnapshot.cashTotal,
    });
  });

  router.post('/api/reset-confirm', async (ctx) => {
    requireRole(ctx, ...ADMIN_ROLES);
    requireCsrf(ctx);
    const body = await readJson(ctx.req);
    if (String(body.confirm ?? '') !== 'پاک کن') throw badRequest('برای تأیید پاک‌سازی کامل باید عبارت «پاک کن» را وارد کنید.', { field: 'confirm' });
    return db.tx(() => {
      const backup = path.join(path.dirname(db.file), `pre-reset-${Date.now()}.json`);
      fs.writeFileSync(
        backup,
        JSON.stringify(
          {
            created_at: nowIso(),
            tables: Object.fromEntries(
              ['settings', 'fx_rates', 'inflation_assumptions', 'accounts', 'products', 'customers', 'suppliers', 'sales', 'sale_lines', 'purchases', 'purchase_lines', 'expenses', 'inventory_adjustments', 'capital_txns', 'loans', 'settlements', 'opening_balances', 'report_snapshots', 'report_corrections', 'audit_log'].map((t) => [
                t,
                db.all(`SELECT * FROM ${t}`),
              ]),
            ),
          },
          null,
          2,
        ),
        'utf8',
      );
      for (const t of ['sale_lines', 'sales', 'purchase_lines', 'purchases', 'expenses', 'inventory_adjustments', 'capital_txns', 'loans', 'settlements', 'opening_balances', 'report_corrections', 'report_snapshots', 'products', 'customers', 'suppliers']) {
        db.run(`DELETE FROM ${t}`);
      }
      db.run(`DELETE FROM settings WHERE key IN ('opening_date','inflation_base_period')`);
      S.audit(db, { userId: ctx.user.id, entity: 'database', entityId: null, action: 'reset', note: `پشتیبان خودکار: ${path.basename(backup)}` });
      const kept = ['fx_rates', 'inflation_assumptions', 'accounts', 'settings', 'users'];
      return json(ctx, {
        ok: true,
        backup: path.basename(backup),
        kept,
        message:
          'تراکنش‌های عملیاتی (فروش، خرید، هزینه، تسویه، گزارش‌های بسته‌شده و کالاها) پاک شد. تاریخچهٔ نرخ دلار، فرض‌های تورم، حساب‌های پولی و حساب‌های کاربری دست‌نخورده ماندند. پیش از پاک‌سازی، پشتیبان خودکار ساخته شد.',
      });
    });
  });

  /* --------------------------------------------------------------- static - */
  function apiOnly(pathname) {
    return pathname.startsWith('/api/');
  }

  const handler = async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      res.setHeader(
        'content-security-policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
          "font-src 'self' https://cdn.jsdelivr.net data:",
          "img-src 'self' data:",
          "connect-src 'self'",
          "form-action 'self'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "object-src 'none'",
        ].join('; '),
      );
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('permissions-policy', 'geolocation=(), camera=(), microphone=()');
      res.setHeader('x-content-type-options', 'nosniff');
      const url = new URL(req.url, 'http://localhost');
      pathname = url.pathname.replace(/\/{2,}/g, '/');
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
      const user = authenticate(db, req);
      const ctx = { req, res, url, params: {}, user, token: parseToken(req.headers.cookie), secure: proto === 'https', ip, query: url.searchParams };

      if (!apiOnly(pathname)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw notFound();
        const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
        if (serveStatic(res, rel, { immutable: rel.startsWith('vendor/') })) return;
        if (/\.[a-z0-9]{2,5}$/i.test(pathname)) throw notFound('فایل یافت نشد.');
        // SPA fallback: client-side routes all resolve to index.html
        if (serveStatic(res, 'index.html')) return;
        throw notFound('صفحه یافت نشد.');
      }

      const match = router.match(req.method, pathname) || router.match(req.method === 'HEAD' ? 'GET' : req.method, pathname);
      if (!match) {
        const allowed = router.methodMismatch(pathname);
        if (allowed.size) {
          res.setHeader('allow', [...allowed].join(', '));
          throw new HttpError(405, 'این روش مجاز نیست.', { allowed: [...allowed] });
        }
        throw notFound('مسیر API یافت نشد.');
      }
      ctx.params = match.params;
      const out = await match.route.handler(ctx);
      if (!res.headersSent) {
        if (out !== undefined && !res.writableEnded) sendJson(res, 200, out);
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[hyper-sina] ${req.method} ${pathname}`, err);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status >= 500 ? 'خطای داخلی سرور. در صورت تکرار با مدیر سیستم تماس بگیرید.' : err.message,
          ...(err.details ? { details: err.details } : {}),
        });
      } else if (!res.writableEnded) res.end();
    } finally {
      if (process.env.HYPER_SINA_LOG === '1') console.log(`${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };

  /** Wrap a handler that wants a parsed body, keeping one read per request. */
  const wrapped = handler;
  wrapped.router = router;
  return wrapped;
}

/* ------------------------------------------------------------- helpers ----- */

function parseToken(cookieHeaderStr) {
  for (const part of String(cookieHeaderStr || '').split(';')) {
    const [k, v] = part.split('=');
    if (k && k.trim() === 'hs_session') return decodeURIComponent((v || '').trim());
  }
  return null;
}

function shiftPeriod(period, delta) {
  const [y, m] = period.split('-').map(Number);
  let ny = y;
  let nm = m + delta;
  while (nm < 1) {
    nm += 12;
    ny -= 1;
  }
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function formatPrevPeriod(period) {
  return shiftPeriod(period, -1);
}

function normalizePeriod(input) {
  const s = String(input || '')
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (!m) throw badRequest('قالب دوره باید ۱۴۰۵-۰۲ باشد.', { field: 'period' });
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) throw badRequest('ماه نامعتبر است.', { field: 'period' });
  return `${m[1]}-${String(mm).padStart(2, '0')}`;
}

function normalizeYear(input) {
  const s = String(input || '')
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  if (!/^\d{4}$/.test(s)) throw badRequest('قالب سال باید ۴ رقمی باشد (۱۴۰۵).', { field: 'year' });
  return s;
}

function rangeParams(ctx, tzValue = DEFAULT_TZ) {
  const today = shopNow(tzValue).date;
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  if (from && to) {
    const f = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
    const t = /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null;
    if (!f || !t) throw badRequest('قالب تاریخ‌ها باید YYYY-MM-DD باشد.', { field: 'from' });
    if (f > t) throw badRequest('تاریخ شروع نمی‌تواند بعد از تاریخ پایان باشد.', { field: 'to' });
    return { from: f, to: t };
  }
  const period = ctx.url.searchParams.get('period');
  if (period) {
    if (/^\d{4}$/.test(period)) {
      const r = jalaliRange(period, 'year');
      return { from: r.from, to: minStr(r.to, today) };
    }
    const norm = normalizePeriod(period);
    const r = jalaliRange(norm, 'month');
    return { from: r.from, to: minStr(r.to, today) };
  }
  const range = ctx.url.searchParams.get('range') || 'month';
  const now = shopNow(tzValue);
  if (range === 'today') return { from: now.date, to: now.date };
  if (range === 'year') {
    const r = jalaliRange(now.jalali.year, 'year');
    return { from: r.from, to: minStr(r.to, now.date) };
  }
  if (range === 'prev') {
    const r = jalaliRange(shiftPeriod(now.jalali.period, -1), 'month');
    return { from: r.from, to: r.to };
  }
  if (range === 'all') return { from: '1800-01-01', to: today };
  const r = jalaliRange(now.jalali.period, 'month');
  return { from: r.from, to: minStr(r.to, now.date) };
}

const minStr = (a, b) => (a <= b ? a : b);
const previousDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

function buildAlerts(month, yearly, fx, accounts, db) {
  const alerts = [];
  if (month.profit.net_rial < 0) alerts.push({ level: 'danger', text: 'سود خالص این ماه منفی (زیان) است.' });
  if (yearly.profit.net_rial < 0) alerts.push({ level: 'danger', text: 'سود خالص امسال منفی (زیان) است.' });
  if (!month.dataGaps.canFinalize) alerts.push({ level: 'warn', text: 'برای گزارش این ماه کاستی داده وجود دارد؛ تا رفع آن نمی‌توان گزارش نهایی بست.' });
  if (month.inventory.negative_items.length) alerts.push({ level: 'warn', text: 'موجودی برخی کالاها منفی شده است؛ خرید/فروش آن‌ها را بررسی کنید.' });
  if (!fx.period.end) alerts.push({ level: 'info', text: 'هنوز هیچ نرخ دلاری ثبت نشده است. برای گزارش ارزی به بخش «مدیریت دلار و تورم» بروید.' });
  else if (fx.period.end_stale_days !== null && fx.period.end_stale_days > 7) alerts.push({ level: 'info', text: `آخرین نرخ دلار به ${fx.period.end_stale_days} روز پیش بازمی‌گردد؛ در صورت نیاز به‌روزرسانی کنید.` });
  if (!accounts.length) alerts.push({ level: 'info', text: 'هنوز صندوق یا حساب بانکی تعریف نشده است.' });
  const hasInflation = db.get('SELECT COUNT(*) AS n FROM inflation_assumptions').n > 0;
  if (!hasInflation) alerts.push({ level: 'info', text: 'برای محاسبهٔ سود واقعی، فرض تورم ماه را در بخش «مدیریت دلار و تورم» ثبت کنید.' });
  return alerts;
}

function snapshotDifferences(snapshotReport, liveReport) {
  const pairs = [
    ['net_sales_rial', snapshotReport?.sales?.net_rial, liveReport?.sales?.net_rial],
    ['cogs_rial', snapshotReport?.sales?.cogs_rial, liveReport?.sales?.cogs_rial],
    ['gross_profit_rial', snapshotReport?.profit?.gross_rial, liveReport?.profit?.gross_rial],
    ['net_profit_rial', snapshotReport?.profit?.net_rial, liveReport?.profit?.net_rial],
    ['inventory_closing_rial', snapshotReport?.inventory?.closing_value_rial, liveReport?.inventory?.closing_value_rial],
    ['fx_end_rate_x100', snapshotReport?.fx?.period?.end_rate_x100, liveReport?.fx?.period?.end_rate_x100],
  ];
  return pairs.filter(([, a, b]) => a !== b).map(([field, a, b]) => ({ field, snapshot: a ?? null, live: b ?? null, delta: Number.isFinite(a) && Number.isFinite(b) ? b - a : null }));
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(db, what, { from, to, businessName }) {
  const header = (cols) => cols.join(',');
  const rows = [];
  const push = (cells) => rows.push(cells.map(csvEscape).join(','));
  push([`هایپر سینا | ${businessName()}`, `بازه: ${from} تا ${to}`, `تاریخ خروجی: ${nowIso()}`]);
  rows.push('');
  if (what === 'expenses') {
    push(['تاریخ', 'دسته', 'مبلغ (ریال)', 'مبلغ (تومان)', 'روش', 'پرداخت‌شده (ریال)', 'یادداشت']);
    for (const r of db.all('SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date, id', [from, to])) {
      push([r.expense_date, EXPENSE_LABELS[r.category] || r.category, r.amount_rial, rialToToman(r.amount_rial), r.payment_method, r.amount_paid_rial ?? r.amount_rial, r.note || '']);
    }
    return rows.join('\r\n');
  }
  if (what === 'monthly' || what === 'yearly') {
    const granularity = what === 'monthly' ? 'month' : 'year';
    push([
      'دوره',
      'فروش ناخالص (ریال)',
      'تخفیف (ریال)',
      'مرجوعی (ریال)',
      'فروش خالص (ریال)',
      'بهای تمام‌شده (ریال)',
      'سود ناخالص (ریال)',
      'هزینه عملیاتی (ریال)',
      'سود عملیاتی (ریال)',
      'سود خالص (ریال)',
      'ورودی نقد (ریال)',
      'خروجی نقد (ریال)',
      'موجودی پایان (ریال)',
      'نرخ دلار پایان (تومان)',
    ]);
    if (granularity === 'month') {
      const periods = db.all('SELECT DISTINCT jperiod AS p FROM (SELECT jperiod FROM sales UNION ALL SELECT jperiod FROM expenses UNION ALL SELECT jperiod FROM purchases) WHERE p IS NOT NULL ORDER BY p');
      for (const { p } of periods) {
        const r = monthReport(db, p).report;
        push([
          formatJalaliPeriod(p),
          r.sales.gross_rial,
          r.sales.discounts_rial,
          r.sales.returns_rial,
          r.sales.net_rial,
          r.sales.cogs_rial,
          r.profit.gross_rial,
          r.expenses.total_rial + r.expenses.inventory_adjustments_rial,
          r.profit.operating_rial,
          r.profit.net_rial,
          r.cash.inflow_rial,
          r.cash.outflow_rial,
          r.inventory.closing_value_rial,
          r.fx?.period?.end_rate_x100 ? r.fx.period.end_rate_x100 / 100 : '',
        ]);
      }
    } else {
      const years = db.all('SELECT DISTINCT substr(jperiod,1,4) AS y FROM sales UNION SELECT DISTINCT substr(jperiod,1,4) FROM expenses ORDER BY 1');
      for (const { y } of years) {
        if (!y) continue;
        const r = yearReport(db, String(y)).report;
        push([
          y,
          r.sales.gross_rial,
          r.sales.discounts_rial,
          r.sales.returns_rial,
          r.sales.net_rial,
          r.sales.cogs_rial,
          r.profit.gross_rial,
          r.expenses.total_rial + r.expenses.inventory_adjustments_rial,
          r.profit.operating_rial,
          r.profit.net_rial,
          r.cash.inflow_rial,
          r.cash.outflow_rial,
          r.inventory.closing_value_rial,
          r.fx?.period?.end_rate_x100 ? r.fx.period.end_rate_x100 / 100 : '',
        ]);
      }
    }
    return rows.join('\r\n');
  }
  if (what === 'inventory') {
    push(['کالا/خدمت', 'کد', 'نوع', 'موجودی', 'مبلغ موجودی (ریال)', 'میانگین بهای واحد (ریال)', 'هزینه جایگزینی واحد (ریال)']);
    for (const p of db.all('SELECT * FROM products ORDER BY name')) {
      push([p.name, p.sku || '', p.kind === 'goods' ? 'کالا' : 'خدمت', p.stock_qty_x1000 / QTY_SCALE, p.stock_cost_rial, p.last_avg_cost_rial, p.replacement_unit_cost_rial ?? '']);
    }
    return rows.join('\r\n');
  }
  if (what === 'fx') {
    push(['تاریخ', 'نرخ دلار (تومان)', 'یادداشت', 'ثبت', 'آخرین ویرایش']);
    for (const r of db.all('SELECT * FROM fx_rates ORDER BY effective_date')) {
      push([r.effective_date, r.rate_toman_x100 / 100, r.note || '', r.created_at, r.updated_at || '']);
    }
    return rows.join('\r\n');
  }
  // default: sales ledger
  push(['تاریخ', 'ساعت', 'مشتری', 'روش', 'کل فاکتور (ریال)', 'دریافتی (ریال)', 'مانده (ریال)', 'یادداشت']);
  for (const s of db.all('SELECT * FROM sales WHERE txn_date BETWEEN ? AND ? ORDER BY txn_date, id', [from, to])) {
    const t = db.get('SELECT COALESCE(SUM(CASE WHEN kind=\'return\' THEN -1 ELSE 1 END * (line_total_rial - discount_rial)),0) AS n FROM sale_lines WHERE sale_id = ?', [s.id]).n;
    const total = t - s.header_discount_rial;
    push([s.txn_date, (s.occurred_at || '').slice(11, 16), s.customer_name || '', s.payment_method, total, s.amount_received_rial, total - s.amount_received_rial, s.note || '']);
  }
  return rows.join('\r\n');
}
