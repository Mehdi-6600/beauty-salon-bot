// The HTTP surface: auth, authorization, validation, idempotency, persistence,
// reports/snapshots and static delivery. Everything here is what a browser (or
// an attacker) actually sends, through the same router production uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.js';

test('a fresh install is empty, asks for setup, and never invents data', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const boot = await app.api.get('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.body.needs_setup, true);
  assert.equal(boot.body.authenticated, false);
  assert.deepEqual(boot.body.user, null);
  assert.equal(Object.values(boot.body.counts).every((n) => n === 0), true, 'no seeded demo rows');
  assert.match(boot.body.app.display_name, /هایپر سینا/);
  assert.equal(boot.body.app.name, 'Hyper Sina');
  assert.ok(boot.body.expense_categories.length === 10, 'the ten expense categories exist');
  assert.ok(boot.body.expense_categories.every((c) => /[\u0600-\u06FF]/.test(c.label)), 'categories are labelled in Persian');
  assert.ok(boot.body.payment_methods.map((m) => m.key).includes('credit'));
  assert.match(boot.body.clock.today_period, /^\d{4}-\d{2}$/);
});

test('account setup: one owner, hashed passwords, session cookie hardening', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  const weak = await app.api.post('/api/auth/register', { username: 'owner', password: '123' });
  assert.equal(weak.status, 400, 'a weak password is refused');
  assert.match(weak.body.error, /رمز/);
  const reg = await app.registerOwner('owner1');
  assert.equal(reg.user.role, 'owner');
  assert.equal(typeof reg.csrf, 'string');
  assert.ok(!JSON.stringify(reg).includes('password'), 'the payload never carries a password');
  const dup = await app.api.post('/api/auth/register', { username: 'second', password: 'Another-Good-Pass-1' });
  assert.equal(dup.status, 403, 'only the first account becomes owner');

  const me = await app.api.get('/api/bootstrap');
  assert.equal(me.body.authenticated, true);
  const health = await app.api.get('/api/auth/me').catch(() => null);
  if (health) assert.ok(!/password_hash/.test(health.text), 'no hash is ever returned');
  const dump = await app.api.get('/api/export.json');
  assert.ok(!/password_hash|scrypt\$/.test(dump.text), 'the backup file must not contain password material');

  await app.logout();
  const after = await app.api.get('/api/bootstrap');
  assert.equal(after.body.authenticated, false, 'logout really destroys the session row');
  await app.api.post('/api/auth/login', { username: 'owner1', password: 'wrong-password-here' }).then(async (bad) => {
    assert.equal(bad.status, 401);
  });
  await app.login('owner1', 'Ramz-e-Karbari-99!');
  const again = await app.api.get('/api/bootstrap');
  assert.equal(again.body.authenticated, true, 'the same credentials work again (hashing is deterministic per user, salt per hash)');
});

test('password change invalidates every other session', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner('rotator');
  const other = { cookie: app.session.cookie };
  const res = await app.api.post('/api/auth/password', { current_password: 'wrong-current', new_password: 'Brand-New-Pass-77' });
  assert.equal(res.status, 400, 'the current password must be proven');
  const ok = await app.api.post('/api/auth/password', { current_password: 'Ramz-e-Karbari-99!', new_password: 'Brand-New-Pass-77' });
  assert.equal(ok.status, 200);
  const stale = await app.raw('GET', '/api/bootstrap', null, {});
  assert.equal(stale.body.authenticated, false, `all sessions are revoked (kept session: ${JSON.stringify(other)})`);
  await app.login('rotator', 'Brand-New-Pass-77');
  assert.equal((await app.api.get('/api/bootstrap')).body.authenticated, true);
});

test('brute force is throttled, and the message does not leak which part was wrong', async (t) => {
  const { throttleClear } = await import('../server/auth.js');
  const app = await startApp();
  t.after(async () => {
    throttleClear('login:127.0.0.1');
    await app.close();
  });
  await app.registerOwner('target');
  await app.logout();
  const tries = [];
  for (let i = 0; i < 10; i += 1) tries.push((await app.api.post('/api/auth/login', { username: 'target', password: 'nope-nope-nope' })).status);
  assert.ok(tries.slice(0, 7).every((s) => s === 401), `early failures should be 401: ${tries}`);
  assert.ok(tries.slice(-2).every((s) => s === 429), `after the limit the API must answer 429: ${tries}`);
  const body = (await app.api.post('/api/auth/login', { username: 'target', password: 'nope-nope-nope' })).body;
  assert.match(body.error, /تلاش ناموفق|دوباره/, 'the throttle message is Persian and gives no account details');
  assert.ok(!/username|نام کاربری/.test(body.error), 'it must not reveal whether the user exists');
});

test('mutating requests need CSRF; reading never does', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const noCsrf = await app.api.post('/api/expenses', { date: (await app.clock()).today, category: 'rent', amount_toman: 10_000, payment_method: 'cash' }, { csrf: null });
  assert.equal(noCsrf.status, 403, 'a form POST without the CSRF token is refused');
  assert.match(noCsrf.body.error, /CSRF/);
  assert.equal((await app.api.get('/api/dashboard')).status, 200, 'GET works without it');
  // and the write itself succeeds once the token is attached
  const ok = await app.api.post('/api/expenses', {
    date: (await app.clock()).today,
    category: 'rent',
    amount_toman: 10_000,
    payment_method: 'cash',
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(ok.status, 201, ok.text);
});

test('roles are enforced on the server, not in the menu', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner('boss');
  const { today } = await app.clock();
  await app.api.post('/api/products', { name: 'چای', kind: 'goods' });
  const prod = (await app.api.get('/api/products')).body.items[0];
  // There is no "create user" API on purpose (only the first account can be made,
  // by whoever installs the app), so the other roles are provisioned directly and
  // given a session with the same helper the login route uses.
  for (const [username, role] of [['worker', 'staff'], ['watcher', 'readonly']]) {
    app.db.run(
      'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)',
      [username, 'not-a-real-hash-placeholder', username, role, new Date().toISOString()],
    );
  }
  await app.logout();
  const { createSession } = await import('../server/auth.js');
  for (const [username, role] of [['worker', 'staff'], ['watcher', 'readonly']]) {
    const user = app.db.get('SELECT * FROM users WHERE username = ?', [username]);
    const { token, csrf } = createSession(app.db, user, {});
    app.session.cookie = `hs_session=${token}`;
    app.session.csrf = csrf;
    const boot = await app.api.get('/api/bootstrap');
    assert.equal(boot.body.user.role, role);
    const write = await app.api.post('/api/products', { name: `توسط-${role}`, kind: 'goods' });
    const expense = await app.api.post('/api/expenses', { date: today, category: 'rent', amount_toman: 5_000, payment_method: 'cash', dedupe_key: app.dedupeKey() });
    if (role === 'staff') {
      assert.equal(write.status, 201, 'staff may record business data');
      assert.equal(expense.status, 201, 'staff may record expenses');
    } else {
      assert.equal(write.status, 403, 'a readonly account cannot write at all');
      assert.equal(expense.status, 403);
    }
    const settings = await app.api.put('/api/settings', { business_name: 'هک' });
    assert.equal(settings.status, 403, 'only the owner changes settings');
    const del = await app.api.del(`/api/products/${prod.id}`, { reason: 'تست' });
    assert.equal(del.status, 403, 'deleting a referenced record is owner-only');
    const view = await app.api.get('/api/dashboard');
    assert.equal(view.status, 200, 'both roles can still see the books');
  }
});

test('validation refuses nonsense before it can reach the ledger', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { today } = await app.clock();
  const product = (await app.api.post('/api/products', { name: 'برنج', kind: 'goods' })).body.item;
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);

  const cases = [
    ['both units at once', '/api/expenses', { date: today, category: 'rent', payment_method: 'cash', amount_toman: 100, amount_rial: 1000 }],
    ['unknown category', '/api/expenses', { date: today, category: 'yacht', payment_method: 'cash', amount_toman: 100 }],
    ['future date', '/api/expenses', { date: future, category: 'rent', payment_method: 'cash', amount_toman: 100 }],
    ['zero amount', '/api/expenses', { date: today, category: 'rent', payment_method: 'cash', amount_toman: 0 }],
    ['negative amount', '/api/expenses', { date: today, category: 'rent', payment_method: 'cash', amount_toman: -100 }],
    ['missing payment method', '/api/expenses', { date: today, category: 'rent', amount_toman: 100 }],
    ['no lines', '/api/sales', { date: today, payment_method: 'cash', lines: [] }],
    ['unknown product', '/api/sales', { date: today, payment_method: 'cash', lines: [{ product_id: 4242, qty: 1, unit_price_toman: 100 }] }],
    ['four decimals in qty', '/api/sales', { date: today, payment_method: 'cash', lines: [{ product_id: product.id, qty: '1.0005', unit_price_toman: 100 }] }],
    ['discount larger than the line', '/api/sales', { date: today, payment_method: 'cash', lines: [{ product_id: product.id, qty: 1, unit_price_toman: 100, discount_toman: 500 }] }],
    ['purchase without lines', '/api/purchases', { purchase_date: today, payment_method: 'cash', lines: [] }],
    ['unknown account', '/api/expenses', { date: today, category: 'rent', payment_method: 'cash', amount_toman: 100, account_id: 999 }],
  ];
  for (const [what, url, body] of cases) {
    const res = await app.api.post(url, { ...body, dedupe_key: app.dedupeKey() });
    assert.equal(res.status, 400, `${what}: expected 400, got ${res.status} ${res.text}`);
    assert.ok(res.body.details?.field, `${what}: the 400 must name the offending field (${JSON.stringify(res.body.details)})`);
  }

  // A client-sent total is never trusted: the server recomputes from qty × price.
  const sneaky = await app.api.post('/api/sales', {
    date: today,
    payment_method: 'cash',
    lines: [{ product_id: product.id, qty: 2, unit_price_toman: 1_000, line_total_rial: 1, total_rial: 1, grand_total: 1 }],
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(sneaky.status, 201, sneaky.text);
  assert.equal(sneaky.body.item.computed.gross_rial, 2 * 1_000 * 10, '2 × 1 000 toman = 20 000 rial, whatever the client claimed');

  const badKey = await app.api.post('/api/expenses', { date: today, category: 'rent', payment_method: 'cash', amount_toman: 1_000, dedupe_key: 'x' });
  assert.equal(badKey.status, 400, 'an idempotency key too short to identify a submission is refused');
});

test('the same submission twice cannot double-count money', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { today, period } = await app.clock();
  const product = (await app.api.post('/api/products', { name: 'روغن', kind: 'goods' })).body.item;
  await app.api.post('/api/purchases', {
    purchase_date: today,
    payment_method: 'cash',
    lines: [{ product_id: product.id, qty: 10, unit_cost_toman: 50_000 }],
    dedupe_key: app.dedupeKey(),
  });
  const key = app.dedupeKey();
  const sale = { date: today, payment_method: 'cash', lines: [{ product_id: product.id, qty: 1, unit_price_toman: 120_000 }], dedupe_key: key };
  const first = await app.api.post('/api/sales', sale);
  assert.equal(first.status, 201);
  const second = await app.api.post('/api/sales', sale);
  assert.equal(second.status, 409, 'a double tap / retry must collide, not duplicate');
  assert.match(second.body.error, /قبلاً|تکراری/);
  assert.equal((await app.api.get('/api/sales')).body.items.length, 1);
  const r = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(r.sales.net_rial, 120_000 * 10, 'the report is not inflated by the refused retry');
  // a different key with identical content is a legitimate second sale
  const third = await app.api.post('/api/sales', { ...sale, dedupe_key: app.dedupeKey() });
  assert.equal(third.status, 201);
});

test('exchange rates: manual only, dated, corrected without rewriting neighbours', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { today, period } = await app.clock();
  const dayBefore = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  const d1 = dayBefore(today, 2);
  const d2 = dayBefore(today, 1);

  await app.api.post('/api/fx', { effective_date: d1, rate_toman: 900_000, note: 'روز اول' });
  await app.api.post('/api/fx', { effective_date: d2, rate_toman: 920_000 });
  const list = (await app.api.get('/api/fx')).body;
  assert.equal(list.items.length, 2, 'each date is its own record');
  assert.match(list.note, /دستی/, 'the API states that rates are hand-entered');
  assert.equal(list.summary.latest.rate_toman_x100, 92_000_000);
  assert.equal(list.summary.change_abs_x100, 2_000_000);
  assert.equal(list.summary.change_pct_x100, Math.round((2_000_000 / 90_000_000) * 10_000), '2.22% is stated in hundredths of a percent');

  // correcting an old day must not move the newer one
  await app.api.post('/api/fx', { effective_date: d1, rate_toman: 1_000_000, reason: 'اشتباه تایپی' });
  const after = (await app.api.get('/api/fx')).body;
  assert.equal(after.items.length, 2, 'a same-day entry updates that day, never appends a shadow row');
  assert.equal(after.items.find((r) => r.effective_date === d1).rate_toman_x100, 100_000_000);
  assert.equal(after.items.find((r) => r.effective_date === d2).rate_toman_x100, 92_000_000, 'the next day is untouched');
  assert.ok(after.items.find((r) => r.effective_date === d1).updated_at, 'the correction is marked');
  const audit = (await app.api.get('/api/audit?limit=50')).body.items;
  assert.ok(audit.some((a) => a.entity === 'fx_rate' && /update|correct/.test(a.action)), 'the correction is in the audit trail');

  // a future-dated rate would rewrite "latest": refuse it
  const future = await app.api.post('/api/fx', { effective_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), rate_toman: 1_500_000 });
  assert.equal(future.status, 400, 'rates cannot be dated in the future');

  // reports pick the latest record up to the period end, and say so
  const rep = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(rep.fx.period.end_rate_x100, 92_000_000, 'the period rate is the last record on or before the period end');
  assert.equal(rep.fx.latest.rate_toman_x100, 92_000_000, 'the corrected older day does not pretend to be current');
  assert.equal(rep.fx.period.records_in_period, 2, 'the average is over the records you actually entered');
  assert.equal(rep.fx.period.avg_rate_x100, (100_000_000 + 92_000_000) / 2);
});

test('a period can pin a chosen saved rate without touching history', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { today, period } = await app.clock();
  const dayBefore = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
  await app.api.post('/api/fx', { effective_date: dayBefore(today, 3), rate_toman: 800_000 });
  await app.api.post('/api/fx', { effective_date: today, rate_toman: 900_000 });
  const items = (await app.api.get('/api/fx')).body.items;
  const older = items.find((r) => r.effective_date === dayBefore(today, 3));
  const pinned = await app.api.post('/api/fx/choice', { period_type: 'month', period, fx_rate_id: older.id });
  assert.equal(pinned.status, 200, pinned.text);
  const rep = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(rep.fx.period.end_rate_x100, 80_000_000, 'the chosen record is used for this period');
  assert.equal(rep.fx.period.end.manual_choice, true, 'the report says the rate was selected by hand');
  const cleared = await app.api.post('/api/fx/choice', { period_type: 'month', period, fx_rate_id: 'auto' });
  assert.equal(cleared.status, 200);
  const back = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(back.fx.period.end_rate_x100, 90_000_000, 'removing the choice returns to the period-end rule');
});

test('inflation is the owner’s own assumption, and its absence is reported as such', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { period } = await app.clock();
  const empty = await app.api.get(`/api/real-profit?period=${period}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.real.available, false, 'no assumption recorded → no invented real profit');
  assert.ok(empty.body.real.missing_periods.length, 'and the missing months are listed by name');
  assert.match(empty.body.disclaimer, /برآورد/);

  const add = await app.api.post('/api/inflation', { period, rate_pct: '3.5', note: 'سبد خودم' });
  assert.equal(add.status, 201, add.text);
  const list = await app.api.get('/api/inflation');
  assert.equal(list.body.items[0].rate_pct_x100, 350);
  const bad = await app.api.post('/api/inflation', { period: '1405-13', rate_pct: 1 });
  assert.equal(bad.status, 400, 'a month that does not exist cannot be accepted');
  const now = await app.api.get(`/api/real-profit?period=${period}`);
  assert.equal(now.body.real.available, true);
  assert.equal(now.body.real.cumulative_factor_x1e6, 1_035_000, 'deflation factor is exactly the entered assumption');
  assert.ok(/نرخ رسمی/.test(JSON.stringify(now.body)), 'the answer is labelled as an estimate, not official inflation');
});

test('closing a month freezes the report; later edits never rewrite it', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const seeded = await app.seedShop();
  void seeded;
  const { today, period } = await app.clock();
  const live = (await app.api.get(`/api/reports/monthly/${period}`)).body;
  const netAtClose = live.report.profit.net_rial;

  const fin = await app.api.post(`/api/reports/monthly/${period}/finalize`, { status: 'final', note: 'بسته‌شدن پایان ماه' });
  assert.equal(fin.status, 201, fin.text);
  const snapId = fin.body.snapshot.id;
  assert.equal(fin.body.snapshot.status, 'final');
  assert.equal(fin.body.snapshot.version, 1);
  assert.ok(fin.body.snapshot.payload_json === undefined, 'the raw blob is not leaked in the list response');

  // money moves after closing: the live report changes, the snapshot does not
  const later = await app.api.post('/api/expenses', {
    date: today,
    category: 'packaging',
    payment_method: 'cash',
    amount_toman: 250_000,
    paid_toman: 250_000,
    note: 'کارتن',
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(later.status, 201, later.text);
  const after = (await app.api.get(`/api/reports/monthly/${period}`)).body;
  assert.equal(after.report.profit.net_rial, netAtClose - 2_500_000, 'live reflects the new expense');
  assert.equal(after.snapshot.differences.length, 1, 'and the difference is announced, not hidden');
  assert.equal(after.snapshot.differences[0].field, 'net_profit_rial');
  const frozen = await app.api.get(`/api/snapshots/${snapId}`);
  assert.equal(frozen.body.report.profit.net_rial, netAtClose, 'the closed version is byte-for-byte what it was');
  assert.equal(frozen.body.report.meta.source, 'snapshot');
  assert.equal(frozen.body.version, 1);

  // recalculation is an explicit, reasoned, versioned workflow
  const noReason = await app.api.post(`/api/snapshots/${snapId}/recalculate`, {});
  assert.equal(noReason.status, 400, 'recalculating a closed report without a reason is refused');
  const recalc = await app.api.post(`/api/snapshots/${snapId}/recalculate`, { reason: 'هزینهٔ کارتن جا افتاد' });
  assert.equal(recalc.status, 201, recalc.text);
  assert.equal(recalc.body.snapshot.version, 2, 'a new version is written beside the old one');
  assert.equal(recalc.body.snapshot.status, 'restated');
  const restated = await app.api.get(`/api/snapshots/${recalc.body.snapshot.id}`);
  assert.equal(restated.body.report.profit.net_rial, netAtClose - 2_500_000);
  assert.ok(restated.body.corrections.some((c) => /کارتن/.test(c.reason)), 'the reason is stored with the correction');
  const stillV1 = await app.api.get(`/api/snapshots/${snapId}`);
  assert.equal(stillV1.body.report.profit.net_rial, netAtClose, 'v1 stays readable forever');
});

test('a month with missing cost data cannot be finalized, only drafted', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { today, period } = await app.clock();
  const product = (await app.api.post('/api/products', { name: 'کالای بی‌بها', kind: 'goods' })).body.item;
  // sell something that was never purchased: revenue is real, COGS is unknowable
  const sale = await app.api.post('/api/sales', {
    date: today,
    payment_method: 'cash',
    lines: [{ product_id: product.id, qty: 1, unit_price_toman: 100_000 }],
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(sale.status, 201, sale.text);
  const rep = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.ok(rep.dataGaps.blocking.some((g) => g.code === 'cogs_unknown' || g.code === 'oversold'), 'the gap is flagged as blocking');
  const final = await app.api.post(`/api/reports/monthly/${period}/finalize`, { status: 'final' });
  assert.equal(final.status, 409, 'an incomplete month cannot be declared final');
  assert.ok(final.body.details.blocking.length, 'the answer lists exactly what is missing');
  const draft = await app.api.post(`/api/reports/monthly/${period}/finalize`, { status: 'draft' });
  assert.equal(draft.status, 201, draft.text);
  assert.equal(draft.body.snapshot.status, 'draft', 'and it is labelled as an estimate, never as a closed report');
  const view = (await app.api.get(`/api/reports/monthly/${period}`)).body;
  assert.equal(view.snapshot.status, 'draft');
});

test('money owed is capped at what is actually owed, in both directions', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const seeded = await app.seedShop();
  const { period } = await app.clock();
  const before = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  const owed = before.receivables.closing_rial;

  const { creditSale } = seeded;
  const invoiceOwed = creditSale.computed.outstanding_rial;
  const tooMuch = await app.api.post('/api/settlements', {
    type: 'customer_receipt',
    date: (await app.clock()).today,
    sale_id: creditSale.id,
    amount_rial: invoiceOwed + 1_000,
    payment_method: 'cash',
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(tooMuch.status, 400, 'on an invoice you cannot collect more than what is outstanding');
  assert.match(tooMuch.body.error, /مانده/);

  // An unlinked receipt may exceed the balance: it becomes a customer advance, and
  // the report says so instead of pretending the invoice was over-paid.
  const advance = await app.api.post('/api/settlements', {
    type: 'customer_receipt',
    date: (await app.clock()).today,
    customer_name: 'آقای حسنی',
    amount_rial: owed + 1_000_000,
    payment_method: 'cash',
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(advance.status, 201, advance.text);
  const withAdvance = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(withAdvance.receivables.credits_rial, 1_000_000, 'the surplus is money we hold for the customer, not income owed to us');
  const party = withAdvance.receivables.byParty.find((x) => x.party === 'آقای حسنی');
  assert.equal(party.outstanding_rial, -1_000_000, 'netted per person, the invoice gap and the advance are visible together');
  assert.equal(withAdvance.receivables.closing_rial, owed, 'the invoice itself still shows what is unpaid on it');
  const undo = await app.api.del(`/api/settlements/${advance.body.item.id}`, { reason: 'اشتباه در ثبت' });
  assert.equal(undo.status, 200, undo.text);
  const reverted = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(reverted.receivables.credits_rial, 0, 'deleting the wrong receipt puts the books back exactly');
  assert.equal(reverted.receivables.closing_rial, owed);

  // Linked to the invoice, the receipt settles it for real.
  const right = await app.api.post('/api/settlements', {
    type: 'customer_receipt',
    date: (await app.clock()).today,
    sale_id: creditSale.id,
    amount_rial: owed,
    payment_method: 'cash',
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(right.status, 201, right.text);
  const after = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(after.receivables.closing_rial, 0, 'the receivable is settled');
  assert.equal(after.cash.closing_rial, before.cash.closing_rial + owed, 'and the cash arrives now — not earlier');
  assert.equal(after.sales.net_rial, before.sales.net_rial, 'collecting a debt is not new income');

  // The same cap holds at the moment of creating the invoice, so a surplus can never
  // hide inside a sale as a negative outstanding (it is an advance, recorded separately).
  const overReceived = await app.api.post('/api/sales', {
    date: (await app.clock()).today,
    payment_method: 'cash',
    received_toman: 1_001,
    lines: [{ product_id: seeded.product.id, qty: 1, unit_price_toman: 100 }],
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(overReceived.status, 400, overReceived.text);
  assert.equal(overReceived.body.details.field, 'received_toman');
  assert.match(overReceived.body.error, /علی‌الحساب/);
});

test('referenced records are archived, not deleted, and deletions need a reason', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const seeded = await app.seedShop();
  const spare = (await app.api.post('/api/products', { name: 'کالای بدون استفاده', kind: 'goods' })).body.item;
  const gone = await app.api.del(`/api/products/${spare.id}`, { reason: 'اشتباه ثبت شد' });
  assert.equal(gone.status, 200, gone.text);
  assert.equal((await app.api.get('/api/products?include_inactive=1')).body.items.find((p) => p.id === spare.id), undefined, 'an unused product really goes away');

  const del1 = await app.api.del(`/api/products/${seeded.product.id}`, { reason: 'توقف فروش' });
  assert.equal(del1.status, 409, 'a product with a history must not be deleted out of the books');
  assert.match(del1.body.error, /غیرفعال/);
  const archive = await app.api.put(`/api/products/${seeded.product.id}`, { active: false, reason: 'فروش این کالا متوقف شد' });
  assert.equal(archive.status, 200, archive.text);
  const products = (await app.api.get('/api/products?include_inactive=1')).body.items;
  const row = products.find((p) => p.id === seeded.product.id);
  assert.ok(row, 'the product still exists — its sales history must stay readable');
  assert.equal(row.active, 0, 'it is archived instead of deleted');
  const activeOnly = (await app.api.get('/api/products')).body.items;
  assert.ok(!activeOnly.some((p) => p.id === seeded.product.id), 'and it disappears from the entry picker');
  const { period } = await app.clock();
  const rep = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.ok(rep.sales.net_rial > 0, 'deleting the product did not erase the revenue it earned');
});

test('the dashboard answers with today, this month and this year, and warns loudly', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const seeded = await app.seedShop();
  void seeded;
  const dash = await app.api.get('/api/dashboard');
  assert.equal(dash.status, 200);
  const d = dash.body;
  assert.match(d.business_name, /.{2,}/);
  for (const key of ['today', 'today_label', 'period', 'period_label', 'today_report', 'month_report', 'previous_month_report', 'year_report', 'fx', 'trend', 'accounts', 'quick', 'alerts']) {
    assert.ok(key in d, `dashboard is missing ${key}`);
  }
  assert.ok(d.trend.length >= 1, 'a monthly trend is present');
  assert.equal(d.today_report.sales.net_rial > 0, true, "today's sales are shown");
  assert.ok(d.alerts.length >= 0);
  assert.ok(d.quick.recent_sales.length >= 2, 'the last few entries are there for a quick look');
  assert.ok(typeof d.fx.latest.rate_toman_x100 === 'number', 'the latest dollar rate is on the dashboard');
  // a loss must be visible as a loss, not hidden by abs()
  const { period } = await app.clock();
  const rep = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  await app.api.post('/api/expenses', {
    date: (await app.clock()).today,
    category: 'other',
    payment_method: 'credit',
    amount_toman: rep.profit.net_rial / 10 + 100_000,
    paid_toman: 0,
    dedupe_key: app.dedupeKey(),
  });
  const flipped = (await app.api.get('/api/dashboard')).body;
  assert.ok(flipped.month_report.profit.net_rial < 0, 'the period turns negative and stays negative');
  assert.ok(flipped.alerts.some((a) => a.level === 'bad' || /زیان|ضرر/.test(a.text)), 'the dashboard says so out loud');
});

test('exports open correctly in Excel and the SPA/asset delivery is safe', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  await app.seedShop();
  const csvRes = await fetch(`${app.base}/api/export.csv?table=sales`, { headers: { cookie: app.session.cookie } });
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
  const csv = { status: csvRes.status, headers: csvRes.headers, text: new TextDecoder().decode(csvBytes) };
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="hyper-sina-sales/);
  assert.deepEqual([csvBytes[0], csvBytes[1], csvBytes[2]], [0xef, 0xbb, 0xbf], 'a UTF-8 BOM, or Excel mangles Persian');
  assert.match(csv.text, /هایپر سینا/);
  for (const table of ['expenses', 'inventory', 'monthly', 'yearly', 'fx']) {
    const res = await app.raw('GET', `/api/export.csv?table=${table}`, null, {});
    assert.equal(res.status, 200, `${table} export failed`);
    assert.ok(res.text.split('\n').length > 2, `${table} export has rows`);
  }
  const dump = await app.raw('GET', '/api/export.json', null, {});
  assert.equal(dump.status, 200);
  assert.match(dump.headers.get('content-disposition'), /backup|json/);
  const parsed = JSON.parse(dump.text);
  assert.equal(parsed.app, 'hyper-sina');
  for (const need of ['sales', 'sale_lines', 'expenses', 'fx_rates', 'inflation_assumptions', 'report_snapshots', 'audit_log']) {
    assert.ok(Array.isArray(parsed.tables[need]), `backup is missing ${need}`);
  }
  assert.ok(parsed.tables.sales.length >= 2);

  const html = await app.raw('GET', '/', null, {});
  assert.equal(html.status, 200);
  assert.match(html.text, /<html[^>]*dir="rtl"[^>]*>/, 'the page is RTL Persian');
  assert.match(html.text, /<html[^>]*lang="fa"[^>]*>/);
  assert.match(html.text, /هایپر سینا/);
  const css = await app.raw('GET', '/app.css', null, {});
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const entry = await app.raw('GET', '/app.js', null, {});
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-type'), /javascript/);
  const missing = await app.raw('GET', '/api/does-not-exist', null, {});
  assert.equal(missing.status, 404);
  const wrongMethod = await app.raw('POST', '/api/bootstrap', {}, {});
  assert.equal(wrongMethod.status, 405, 'a GET-only route answers 405 with Allow');
  assert.match(wrongMethod.headers.get('allow') || '', /GET/);
  const traversal = await app.raw('GET', '/../package.json', null, {});
  assert.notEqual(traversal.status, 200, 'path traversal must not serve files outside web/');
  const inside = await app.raw('GET', '/..%2fserver/app.js', null, {});
  assert.notEqual(inside.status, 200);
  const csp = html.headers.get('content-security-policy');
  assert.ok(csp && /default-src 'self'/.test(csp), 'a CSP is set');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
});

test('settings round-trip and show up everywhere they should', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const put = await app.api.put('/api/settings', { business_name: 'سوپرمارکت هایپر سینا', currency_display_unit: 'rial' });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.settings.business_name, 'سوپرمارکت هایپر سینا');
  const boot = await app.api.get('/api/bootstrap');
  assert.equal(boot.body.business_name, 'سوپرمارکت هایپر سینا');
  assert.equal(boot.body.settings.currency_display_unit, 'rial');
  const dash = await app.api.get('/api/dashboard');
  assert.equal(dash.body.business_name, 'سوپرمارکت هایپر سینا');
  const bad = await app.api.put('/api/settings', { currency_display_unit: 'dollar' });
  assert.equal(bad.status, 400, 'an unknown unit is refused, not stored');
  const unknown = await app.api.put('/api/settings', { evil_key: 'x' });
  assert.equal(unknown.status, 200, 'unknown keys are ignored rather than written');
  assert.ok(!('evil_key' in (await app.api.get('/api/settings')).body.settings));
  const long = await app.api.put('/api/settings', { business_name: 'ب'.repeat(500) });
  assert.equal(long.status, 400, 'length limits are enforced server-side');
});

test('opening balances start the books and are never income or expense', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { today, period } = await app.clock();
  const acc = (await app.api.post('/api/accounts', { name: 'بانک ملت', type: 'bank', opening_balance_toman: 20_000_000 })).body.item;
  const product = (await app.api.post('/api/products', { name: 'پنیر', kind: 'goods', opening_qty: 40, opening_unit_cost_toman: 60_000 })).body.item;
  const ob = await app.api.post('/api/opening-balances', {
    kind: 'receivable',
    party_name: 'مشتری قدیمی',
    amount_toman: 800_000,
    occurred_date: today,
    note: 'از قبل باقی مانده',
  });
  assert.equal(ob.status, 201, ob.text);
  const badKind = await app.api.post('/api/opening-balances', { kind: 'inventory', party_name: 'x', amount_toman: 1 });
  assert.equal(badKind.status, 400, 'only balances the ledger can carry are accepted');

  const rep = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(rep.cash.opening_rial, 200_000_000, 'the bank balance starts the cash statement');
  assert.ok(rep.cash.byAccount.some((a) => a.id === acc.id && a.opening_rial === 200_000_000));
  assert.equal(rep.inventory.items.find((i) => i.name === 'پنیر').opening_qty_x1000, 40_000, 'the stock count starts the inventory');
  assert.equal(rep.inventory.movement.opening_rial, 40 * 60_000 * 10);
  assert.equal(rep.inventory.movement.residual_rial, 0);
  assert.equal(rep.receivables.carried_opening_rial, 8_000_000, 'the old debt is carried in, visible as its own line');
  assert.equal(rep.sales.net_rial, 0, 'opening balances are not sales');
  assert.equal(rep.expenses.total_rial, 0, 'and not expenses');
  assert.equal(rep.profit.net_rial, 0, 'so profit starts at zero');
  assert.equal(rep.purchases.total_rial, 0, 'and not a purchase');
  const stock = (await app.api.get('/api/products')).body.items.find((p) => p.id === product.id);
  assert.equal(stock.stock_qty_x1000, 40_000, 'the opening count is real stock, immediately sellable');
});

test('inventory adjustments keep the roll-forward honest', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const seeded = await app.seedShop();
  const { today, period } = await app.clock();
  const adj = await app.api.post('/api/inventory/adjustments', {
    date: today,
    product_id: seeded.product.id,
    delta_qty: -1,
    reason: 'damage',
    note: 'یک شیشه شکست',
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(adj.status, 201, adj.text);
  const rep = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(rep.inventory.items.find((i) => i.sku === 'SH-100').closing_qty_x1000, 4_000, 'the count went down');
  assert.equal(rep.inventory.movement.adjustments_rial, -42_000 * 10, 'at the weighted average cost');
  assert.equal(rep.inventory.movement.residual_rial, 0, 'and the roll-forward still closes');
  assert.equal(rep.expenses.total_rial, 500_000 * 10, 'the rent is the only booked expense category');
  assert.equal(rep.expenses.inventory_adjustments_rial, 42_000 * 10, 'the loss is listed as its own operating charge');
  assert.equal(rep.profit.operating_rial, rep.profit.gross_rial - (rep.expenses.total_rial + rep.expenses.inventory_adjustments_rial), 'and it is deducted from profit exactly once');
  const negative = await app.api.post('/api/inventory/adjustments', {
    date: today,
    product_id: seeded.product.id,
    delta_qty: -999,
    reason: 'damage',
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(negative.status, 400, 'stock can never be adjusted below zero');
});

test('a wipe is previewed, confirmed by typing, and always backed up first', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  await app.seedShop();
  const preview = await app.api.post('/api/reset-preview', {});
  assert.equal(preview.status, 200);
  assert.equal(preview.body.rows.sales, 2);
  assert.match(preview.body.note, /پاک نمی‌کند|بدون تأیید/);
  const wrong = await app.api.post('/api/reset-confirm', { confirm: 'بله' });
  assert.equal(wrong.status, 400, 'only the exact phrase works');
  const done = await app.api.post('/api/reset-confirm', { confirm: 'پاک کن' });
  assert.equal(done.status, 200, done.text);
  assert.equal((await app.api.get('/api/sales')).body.items.length, 0, 'business records are gone');
  assert.equal((await app.api.get('/api/bootstrap')).body.authenticated, true, 'the owner account survives a data wipe');
  assert.ok(done.body.kept.includes('fx_rates'), 'the answer states that the hand-entered rate history is kept');
  assert.equal((await app.api.get('/api/fx')).body.items.length, 2, 'rate history is expensive to rebuild and is never destroyed silently');
  assert.ok((await app.api.get('/api/accounts')).body.items.length >= 1, 'accounts stay so the next entry has a cash box');
  const fs = await import('node:fs');
  const backups = fs.readdirSync(app.dir).filter((f) => f.startsWith('pre-reset-'));
  assert.equal(backups.length, 1, 'a backup file is written before anything is deleted');
  const parsed = JSON.parse(fs.readFileSync(`${app.dir}/${backups[0]}`, 'utf8'));
  assert.ok(parsed.tables.sales.length >= 2, 'and it contains the rows that were removed');
});
