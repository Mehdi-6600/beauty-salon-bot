// Shared test harness: a real HTTP server on an ephemeral port, backed by a
// throwaway SQLite file per test. No mocks — every assertion goes through the
// same code path a browser uses (cookies, CSRF header, JSON bodies).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

export async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyper-sina-test-'));
  const db = createDb({ file: path.join(dir, 'api.db') });
  const server = http.createServer(createHandler(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const session = { cookie: null, csrf: null };

  async function raw(method, url, body, opts = {}) {
    const headers = {};
    if (session.cookie && !opts.anonymous) headers.cookie = session.cookie;
    if (opts.csrf === undefined ? session.csrf && method !== 'GET' : opts.csrf) headers['x-csrf-token'] = session.csrf;
    if (opts.csrf === null) delete headers['x-csrf-token'];
    let payload;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        payload = body;
        headers['content-type'] = opts.contentType || 'application/json';
      } else {
        payload = JSON.stringify(body);
        headers['content-type'] = 'application/json';
      }
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(';')[0];
      if (pair.startsWith('hs_session=')) session.cookie = pair;
      if (/hs_session=;/.test(pair) || /hs_session=([^;]*);.*Max-Age=0/.test(c)) session.cookie = pair.includes('=;') ? null : session.cookie;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (json?.csrf) session.csrf = json.csrf;
    return { status: res.status, body: json, text, headers: res.headers };
  }

  const api = {
    get: (u, o) => raw('GET', u, null, o),
    post: (u, b, o) => raw('POST', u, b ?? {}, o),
    put: (u, b, o) => raw('PUT', u, b ?? {}, o),
    del: (u, b, o) => raw('DELETE', u, b ?? {}, o),
  };

  async function registerOwner(username = `owner_${Math.random().toString(36).slice(2, 8)}`) {
    const res = await api.post('/api/auth/register', { username, password: 'Ramz-e-Karbari-99!', display_name: 'مالک آزمایش' });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.text}`);
    return res.body;
  }

  async function login(username, password) {
    const res = await api.post('/api/auth/login', { username, password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text}`);
    return res.body;
  }

  async function logout() {
    await api.post('/api/auth/logout', {});
    session.cookie = null;
    session.csrf = null;
  }

  let keys = 0;
  const dedupeKey = () => `11111111-1111-4111-8111-${String(++keys).padStart(12, '0')}`;

  /** Today in the shop's own calendar, so no test depends on UTC vs Tehran. */
  async function clock() {
    const c = (await api.get('/api/bootstrap')).body.clock;
    return { ...c, period: c.today_period, year: c.this_year };
  }

  /**
   * A deterministic little shop: opening cash, one stocked product, a purchase,
   * a cash sale, a credit sale, a rent expense, two FX records, one inflation
   * assumption. Numbers are hand-checkable (see accounting.test.js).
   */
  async function seedShop(over = {}) {
    const c = await clock();
    const today = c.today;
    const out = { today, period: c.today_period, year: c.this_year };
    out.account = (await api.post('/api/accounts', { name: 'صندوق مغازه', type: 'cash', opening_balance_toman: 5_000_000, is_default: true })).body.item;
    out.product = (await api.post('/api/products', { name: 'شامپو سر', sku: 'SH-100', kind: 'goods', unit: 'عدد' })).body.item;
    out.service = (await api.post('/api/products', { name: 'مشاوره', kind: 'service' })).body.item;
    out.purchase = (
      await api.post('/api/purchases', {
        purchase_date: today,
        payment_method: 'cash',
        supplier_name: 'پخش مرکزی',
        account_id: out.account.id,
        extra_cost_toman: 20_000,
        paid_toman: 300_000,
        lines: [{ product_id: out.product.id, qty: 10, unit_cost_toman: 40_000 }],
        dedupe_key: dedupeKey(),
        ...over.purchase,
      })
    ).body.item;
    out.cashSale = (
      await api.post('/api/sales', {
        date: today,
        payment_method: 'cash',
        account_id: out.account.id,
        customer_name: 'مشتری نقدی',
        received_toman: 700_000,
        lines: [{ product_id: out.product.id, qty: 2, unit_price_toman: 350_000 }],
        dedupe_key: dedupeKey(),
      })
    ).body.item;
    out.creditSale = (
      await api.post('/api/sales', {
        date: today,
        payment_method: 'credit',
        customer_name: 'آقای حسنی',
        discount_toman: 100_000,
        lines: [{ product_id: out.product.id, qty: 3, unit_price_toman: 350_000 }],
        dedupe_key: dedupeKey(),
      })
    ).body.item;
    out.expense = (
      await api.post('/api/expenses', {
        date: today,
        category: 'rent',
        payment_method: 'cash',
        amount_toman: 500_000,
        paid_toman: 500_000,
        account_id: out.account.id,
        note: 'اجارهٔ این ماه',
        dedupe_key: dedupeKey(),
      })
    ).body.item;
    out.fxDay1 = (await api.post('/api/fx', { effective_date: dayBefore(today, 20), rate_toman: 900_000, note: 'ابتدای دوره' })).body.item;
    out.fxToday = (await api.post('/api/fx', { effective_date: today, rate_toman: 950_000, note: 'امروز' })).body.item;
    out.inflation = (await api.post('/api/inflation', { period: out.period, rate_pct: 2.5, note: 'فرض خودم' })).body.item;
    return out;
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, db, dir, api, raw, registerOwner, login, logout, clock, dedupeKey, seedShop, close, session };
}

export function dayBefore(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Toman amount helper so tests read like the UI does. */
export const toman = (v) => v;
