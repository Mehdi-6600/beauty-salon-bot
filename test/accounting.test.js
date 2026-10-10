// The accounting engine, checked against arithmetic a human can redo by hand.
// All fixture amounts below are toman; the DB stores rial (×10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './harness.js';

const T = (toman) => toman * 10; // toman → rial

test('P&L: net sales, weighted-average COGS, gross/operating/net, no double counting', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const seeded = await app.seedShop();
  assert.ok(seeded.purchase, 'fixture seeded');

  const { period } = await app.clock();
  const res = await app.api.get(`/api/reports/monthly/${period}`);
  assert.equal(res.status, 200);
  const r = res.body.report;

  // Net sales = (2×350 000) + (3×350 000 − 100 000 header discount) = 700 000 + 950 000
  assert.equal(r.sales.gross_rial, T(1_750_000), 'gross sales before discount');
  assert.equal(r.sales.discounts_rial, T(100_000), 'discounts subtracted once');
  assert.equal(r.sales.returns_rial, 0, 'no returns in fixture');
  assert.equal(r.sales.net_rial, T(1_650_000), 'net sales');

  // Weighted average unit cost = (10×40 000 + 20 000 transport) / 10 = 42 000
  const shampoo = r.inventory.items.find((x) => x.sku === 'SH-100');
  assert.equal(shampoo.avg_unit_cost_rial, T(42_000), 'extra cost is capitalised into inventory cost');
  assert.equal(shampoo.sold_qty_x1000, 5_000);
  assert.equal(r.sales.cogs_rial, T(5 * 42_000), 'COGS = units actually sold × weighted average');

  assert.equal(r.profit.gross_rial, r.sales.net_rial - r.sales.cogs_rial);
  assert.equal(r.profit.gross_rial, T(1_440_000));
  // Operating = gross − opex; the rent is the only opex, and it is not counted twice
  assert.equal(r.expenses.total_rial, T(500_000));
  assert.equal(r.profit.operating_rial, T(940_000));
  assert.equal(r.profit.net_rial, T(940_000), 'no financial charges → net equals operating');
  assert.equal(r.expenses.loan_interest_rial, 0, 'no financial charges in the fixture');
  assert.equal(r.profit.net_sales_rial, r.sales.net_rial, 'net sales reported once, from one place');

  // margins
  assert.equal(r.profit.margins_pct_x100.gross, Math.round((1_440_000 / 1_650_000) * 10000));
});

test('a return comes back at the cost it left at — in rial per unit, not per thousandth', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const { product, cashSale, period, today } = await app.seedShop();
  // The seed sells 5 units at an average cost of 42 000 toman. Putting one of the two
  // cash-sale units back must add exactly 42 000 toman of value (420 000 rial) to the
  // shelf and take exactly that out of COGS. A scale slip here is invisible to the
  // roll-forward invariant, so the values themselves are asserted.
  const sale = (await app.api.get(`/api/sales/${cashSale.id}`)).body;
  const line = sale.lines.find((l) => l.kind === 'sale');
  assert.ok(line && line.cogs_rial === T(2 * 42_000), 'the seeded line carried both units at 42 000');
  const put = await app.api.put(`/api/sales/${cashSale.id}`, {
    date: today,
    payment_method: 'cash',
    received_toman: 350_000,
    reason: 'یک عدد برگشت داده شد',
    lines: [
      { id: line.id, product_id: product.id, qty: 2, unit_price_toman: 350_000 },
      { product_id: product.id, qty: 1, unit_price_toman: 350_000, kind: 'return', origin_line_id: line.id },
    ],
  });
  assert.equal(put.status, 200, put.text);
  const r = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  const shampoo = r.inventory.items.find((x) => x.sku === 'SH-100');
  assert.equal(shampoo.closing_qty_x1000, 6_000, '10 bought − 5 sold + 1 returned');
  assert.equal(r.sales.returns_rial, T(350_000), 'the returned unit is taken off net sales');
  assert.equal(r.sales.net_rial, T(1_650_000 - 350_000));
  assert.equal(r.sales.cogs_rial, T(4 * 42_000), 'four units stayed sold');
  assert.equal(r.inventory.movement.closing_rial, T(6 * 42_000), 'six units on the shelf, at cost');
  assert.equal(r.inventory.closing_value_rial, T(6 * 42_000));
  assert.equal(shampoo.avg_unit_cost_rial, T(42_000), 'the average does not move when goods come back at their own cost');
  assert.equal(r.inventory.movement.residual_rial, 0, 'and the roll-forward still closes');
});

test('inventory roll-forward closes exactly (opening + purchases − cogs = closing)', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  await app.seedShop();
  const { period } = await app.clock();
  const r = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;

  assert.equal(r.inventory.movement.opening_rial, 0);
  assert.equal(r.inventory.movement.purchases_rial, T(420_000));
  assert.equal(r.inventory.movement.cogs_rial, T(210_000));
  assert.equal(r.inventory.movement.closing_rial, T(210_000));
  assert.equal(r.inventory.movement.residual_rial, 0, 'roll-forward must not leak a single rial');
  assert.equal(r.inventory.items.reduce((a, x) => a + x.closing_qty_x1000, 0), 5_000);
  assert.equal(r.inventory.closing_value_rial, r.inventory.movement.closing_rial, 'inventory value = book cost of what is left');
});

test('cash vs profit are different statements: cash ≠ net profit, by design', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  await app.seedShop();
  const { period } = await app.clock();
  const r = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;

  // cash = 5 000 000 opening + 700 000 received − 300 000 purchase − 500 000 rent
  assert.equal(r.cash.opening_rial, T(5_000_000));
  assert.equal(r.cash.inflow_rial, T(700_000));
  assert.equal(r.cash.outflow_rial, T(800_000));
  assert.equal(r.cash.closing_rial, T(4_900_000));
  assert.notEqual(r.cash.closing_rial, r.profit.net_rial, 'a personal accountant must not confuse the two');

  // receivables / payables are shown as their own lines
  assert.equal(r.receivables.closing_rial, T(950_000), 'credit sale is income owed, not cash');
  assert.equal(r.payables.closing_rial, T(120_000), 'unpaid part of the purchase');
});

test('owner money and loan principal never touch profit', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  await app.seedShop();
  const { period, today } = await app.clock();
  const before = (await app.api.get(`/api/reports/monthly/${period}`)).body.report.profit.net_rial;

  const dep = await app.api.post('/api/capital', { date: today, type: 'deposit', amount_toman: 10_000_000, note: 'آوردهٔ مالک' });
  assert.equal(dep.status, 201, dep.text);
  const loanIn = await app.api.post('/api/loans', { date: today, type: 'loan_in', amount_toman: 3_000_000, counterparty: 'بانک' });
  assert.equal(loanIn.status, 201, loanIn.text);
  const repay = await app.api.post('/api/loans', { date: today, type: 'loan_repayment', amount_toman: 400_000 });
  assert.equal(repay.status, 201, repay.text);
  const interest = await app.api.post('/api/loans', { date: today, type: 'loan_interest', amount_toman: 50_000 });
  assert.equal(interest.status, 201, interest.text);

  const after = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(after.profit.net_rial, before - T(50_000), 'only the interest is a P&L charge; principal never is');
  assert.equal(after.profit.operating_rial, before, 'interest sits below the operating line, never inside opex or COGS');
  assert.equal(after.capital.deposits_rial, T(10_000_000), 'deposit is equity, reported separately');
  assert.equal(after.loans.borrowed_rial, T(3_000_000));
  assert.equal(after.loans.repaid_rial, T(400_000), 'repayment reduces the loan, not the profit');
  assert.equal(after.loans.interest_rial, T(50_000));
  assert.equal(after.cash.closing_rial, T(4_900_000) + T(10_000_000) + T(3_000_000) - T(400_000) - T(50_000), 'cash does see all of it');
  assert.equal(after.inventory.movement.residual_rial, 0);
});

test('returns: capped at what was sold, restock the unit, and cannot orphan a line', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  const seeded = await app.seedShop();
  const { today, period } = await app.clock();
  const origin = seeded.creditSale.lines[0]; // 3 × 350 000 toman, header discount 100 000

  const noRef = await app.api.post('/api/sales', {
    date: today,
    payment_method: 'cash',
    lines: [{ product_id: seeded.product.id, qty: 1, unit_price_toman: 350_000, kind: 'return' }],
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(noRef.status, 400, 'a return without origin_line_id is rejected, not guessed');
  assert.match(noRef.body.error, /مرجوعی/);

  const tooMuch = await app.api.post('/api/sales', {
    date: today,
    payment_method: 'cash',
    customer_name: 'آقای حسنی',
    lines: [
      { product_id: seeded.product.id, qty: 3, unit_price_toman: 350_000 },
      { product_id: seeded.product.id, qty: 4, unit_price_toman: 350_000, kind: 'return', origin_line_id: origin.id },
    ],
    discount_rial: seeded.creditSale.header_discount_rial,
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(tooMuch.status, 400, 'you cannot return more than was sold on that line');

  // Partial refund on the original invoice: the return line joins the invoice it belongs to.
  const edit = await app.api.put(`/api/sales/${seeded.creditSale.id}`, {
    date: today,
    payment_method: 'credit',
    customer_name: 'آقای حسنی',
    reason: 'یک عدد شامپو مرجوع شد',
    discount_rial: seeded.creditSale.header_discount_rial,
    lines: [
      { id: origin.id, product_id: seeded.product.id, qty: 3, unit_price_toman: 350_000 },
      { product_id: seeded.product.id, qty: 1, unit_price_toman: 350_000, kind: 'return', origin_line_id: origin.id },
    ],
  });
  assert.equal(edit.status, 200, edit.text);
  const c = edit.body.item.computed;
  assert.equal(c.gross_rial, T(1_050_000));
  assert.equal(c.returns_rial, T(350_000), 'the return is netted off this invoice only once');
  assert.equal(c.total_rial, T(1_050_000 - 100_000 - 350_000), 'net invoice = gross − header discount − returns');
  assert.equal(c.outstanding_rial, T(600_000), 'nothing was received, so the customer owes the reduced amount');

  // The same line cannot be over-returned afterwards.
  const again = await app.api.put(`/api/sales/${seeded.creditSale.id}`, {
    date: today,
    payment_method: 'credit',
    reason: 'تلاش برای مرجوعی بیشتر',
    discount_rial: seeded.creditSale.header_discount_rial,
    lines: [
      { id: origin.id, product_id: seeded.product.id, qty: 3, unit_price_toman: 350_000 },
      { product_id: seeded.product.id, qty: 3, unit_price_toman: 350_000, kind: 'return', origin_line_id: origin.id },
    ],
  });
  assert.equal(again.status, 400, '1 already returned of 3 → 3 more is refused');

  // A returned line cannot be deleted out from under its return record.
  const orphan = await app.api.put(`/api/sales/${seeded.creditSale.id}`, {
    date: today,
    payment_method: 'credit',
    reason: 'حذف ردیف اصلی',
    discount_rial: seeded.creditSale.header_discount_rial,
    lines: [{ product_id: seeded.product.id, qty: 1, unit_price_toman: 350_000, kind: 'return', origin_line_id: origin.id }],
  });
  assert.equal(orphan.status, 400, 'the origin line must not vanish while it is referenced');
  assert.match(orphan.body.error, /مرجوع/);

  const r = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(r.sales.returns_rial, T(350_000));
  assert.equal(r.sales.net_rial, T(1_650_000 - 350_000), 'Net Sales = gross − discounts − returns');
  assert.equal(r.inventory.items.reduce((a, x) => a + x.closing_qty_x1000, 0), 6_000, 'the returned unit is back in stock');
  assert.equal(r.inventory.movement.residual_rial, 0, 'restock keeps the roll-forward exact');
  assert.ok(r.inventory.items.every((x) => x.closing_value_rial >= 0));
});

test('a purchase that was never sold is inventory, never an expense', async (t) => {
  const app = await startApp();
  t.after(() => app.close());
  await app.registerOwner();
  await app.seedShop();
  const { today, period } = await app.clock();
  const res = await app.api.post('/api/purchases', {
    purchase_date: today,
    payment_method: 'transfer',
    lines: [{ product_id: (await app.api.get('/api/products')).body.items[0].id, qty: 100, unit_cost_toman: 10_000 }],
    dedupe_key: app.dedupeKey(),
  });
  assert.equal(res.status, 201, res.text);
  const r = (await app.api.get(`/api/reports/monthly/${period}`)).body.report;
  assert.equal(r.expenses.total_rial, T(500_000), 'the rent is still the only expense');
  assert.equal(r.inventory.movement.purchases_rial, T(420_000 + 1_000_000));
  // Purchases carry a date but no clock time, so a purchase dated today is part
  // of today's weighted average — the documented convention for same-day stock.
  assert.ok(r.sales.cogs_rial < T(210_000), 'a cheaper same-day restock lowers COGS, it does not add an expense');
  assert.equal(r.inventory.movement.residual_rial, 0, 'still closes exactly');
  assert.equal(r.cash.closing_rial, T(4_900_000 - 1_000_000), 'paid purchases do move cash — via the default account — while profit stays untouched');
});
