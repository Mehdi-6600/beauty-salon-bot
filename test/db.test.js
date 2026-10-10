// Persistence layer: migrations must be ordered, checksummed, repeatable, and
// never destructive; transactions must be atomic; and the safety constraints
// the accounting rules lean on (unique dedupe key, foreign keys) must hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDb, listMigrations, migrate, defaultDbFile, dedupeConflict, MIGRATIONS_DIR } from '../server/db.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hyper-sina-db-'));

test('migrations are numbered, applied once, and re-runnable', () => {
  const dir = tmp();
  const file = path.join(dir, 'a.db');
  const raw = new DatabaseSync(file);
  const first = migrate(raw);
  assert.ok(first.length >= 3, `expected at least 3 migrations, got ${first.length}`);
  assert.deepEqual(first, [...first].sort(), 'applied in name order');
  assert.deepEqual(migrate(raw), [], 'a second run applies nothing');
  raw.close();
  const db = createDb({ file });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM schema_migrations').n, first.length, 'createDb records exactly those migrations');
  assert.deepEqual(migrate(db.sqlite), [], 'a db opened by createDb is already migrated');
  db.close();

  const db2 = createDb({ file });
  assert.deepEqual(migrate(db2.sqlite), [], 'reopening an existing database does not replay migrations');
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every applied migration is fingerprinted with its file checksum', () => {
  const names = listMigrations();
  assert.ok(names.length >= 3);
  for (const name of names) assert.match(name, /^\d{3}_[a-z0-9_]+\.sql$/, `${name} must be NNN_snake_case.sql`);

  const dir = tmp();
  const db = createDb({ file: path.join(dir, 'b.db') });
  const rows = db.all('SELECT name, checksum FROM schema_migrations ORDER BY name');
  assert.deepEqual(rows.map((r) => r.name), names);
  for (const row of rows) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, row.name), 'utf8');
    const expect = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    assert.equal(row.checksum, expect, `${row.name}: stored checksum must match the file that ran`);
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an edited migration is refused instead of silently trusted', () => {
  const dir = tmp();
  const migDir = path.join(dir, 'migrations');
  fs.mkdirSync(migDir);
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t (id INTEGER PRIMARY KEY);\n');
  const file = path.join(dir, 'c.db');
  const raw = new DatabaseSync(file);
  assert.deepEqual(migrate(raw, migDir), ['001_a.sql']);
  fs.writeFileSync(path.join(migDir, '001_a.sql'), 'CREATE TABLE t (id INTEGER PRIMARY KEY, extra TEXT);\n');
  assert.throws(() => migrate(raw, migDir), /checksum drift/, 'editing history must be loud, not quiet');
  raw.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migrations never drop a table', () => {
  for (const name of listMigrations()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    assert.doesNotMatch(sql, /drop\s+table/i, `${name} must not DROP TABLE — data loss is not a migration`);
    assert.doesNotMatch(sql, /delete\s+from\s+(sales|purchases|expenses|sale_lines|purchase_lines)\b/i, `${name} must not delete financial rows`);
  }
});

test('the schema keeps the invariants the ledger relies on', () => {
  const dir = tmp();
  const db = createDb({ file: path.join(dir, 'd.db') });
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const need of ['users', 'sessions', 'products', 'sales', 'sale_lines', 'purchases', 'purchase_lines', 'expenses', 'accounts', 'settlements', 'fx_rates', 'inflation_assumptions', 'inventory_adjustments', 'capital_txns', 'loans', 'opening_balances', 'report_snapshots', 'report_corrections', 'audit_log', 'settings']) {
    assert.ok(tables.includes(need), `missing table ${need}`);
  }
  const cols = db.all('PRAGMA table_info(purchases)').map((c) => c.name);
  for (const need of ['jperiod', 'jyear', 'extra_cost_rial', 'amount_paid_rial', 'dedupe_key']) {
    assert.ok(cols.includes(need), `purchases.${need} is required for period reports and idempotency`);
  }
  const snap = db.all('PRAGMA table_info(report_snapshots)').map((c) => c.name);
  for (const need of ['period_type', 'period', 'version', 'status', 'payload_json', 'fx_end_date', 'fx_rate_end_id', 'inflation_base_period', 'computed_at', 'calc_warnings_json']) {
    assert.ok(snap.includes(need), `report_snapshots.${need} is what makes a closed report reproducible`);
  }
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('transactions roll back completely, including partial money writes', () => {
  const dir = tmp();
  const db = createDb({ file: path.join(dir, 'e.db') });
  const before = db.get('SELECT COUNT(*) AS n FROM products').n;
  assert.throws(
    () =>
      db.tx(() => {
        db.run("INSERT INTO products (name, kind, unit, created_at) VALUES ('x', 'goods', 'عدد', '2026-01-01T00:00:00Z')");
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.equal(db.get('SELECT COUNT(*) AS n FROM products').n, before, 'the insert must not survive the rollback');
  db.tx(() => {
    db.run("INSERT INTO products (name, kind, unit, created_at) VALUES ('y', 'goods', 'عدد', '2026-01-01T00:00:00Z')");
    db.tx(() => {
      db.run("INSERT INTO products (name, kind, unit, created_at) VALUES ('z', 'goods', 'عدد', '2026-01-01T00:00:00Z')");
    });
  });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM products').n, before + 2, 'nested savepoints commit with the parent');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a rolled-back nested savepoint leaves the parent transaction usable', () => {
  const dir = tmp();
  const db = createDb({ file: path.join(dir, 'f.db') });
  db.tx(() => {
    db.run("INSERT INTO products (name, kind, unit, created_at) VALUES ('keep', 'goods', 'عدد', '2026-01-01T00:00:00Z')");
    assert.throws(() =>
      db.tx(() => {
        db.run("INSERT INTO products (name, kind, unit, created_at) VALUES ('drop', 'goods', 'عدد', '2026-01-01T00:00:00Z')");
        throw new Error('inner');
      }),
    );
  });
  assert.deepEqual(db.all('SELECT name FROM products').map((r) => r.name), ['keep'], 'only the failed savepoint is undone');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('foreign keys are enforced and dedupe keys are unique', () => {
  const dir = tmp();
  const db = createDb({ file: path.join(dir, 'g.db') });
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1, 'FK enforcement must be on, orphans are not accounting');
  assert.throws(() =>
    db.run(
      "INSERT INTO sale_lines (sale_id, product_id, description, kind, qty_x1000, unit_price_rial, line_total_rial, created_at) VALUES (999, 1, 'x', 'sale', 1, 1, 1, '2026-01-01T00:00:00Z')",
    ),
  );
  const sql = `INSERT INTO sales (occurred_at, txn_date, jperiod, jyear, payment_method, amount_received_rial, dedupe_key, created_at)
               VALUES ('2026-01-01T10:00','2026-01-01','1404-10','1404','cash',10,'k-1','2026-01-01T00:00:00Z')`;
  db.run(sql);
  assert.throws(() => db.run(sql), /UNIQUE/, 'the same submission twice must collide');
  const dup = dedupeConflict(new Error('UNIQUE constraint failed: sales.dedupe_key'));
  assert.equal(dup, true, 'collision is recognised so the API can answer 409 instead of 500');
  assert.equal(dedupeConflict(new Error('UNIQUE constraint failed: products.name')), false, 'other unique keys are real errors');
  assert.equal(dedupeConflict(new Error('check constraint failed')), false);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every money column has INTEGER affinity — there is no float column to drift in', () => {
  const dir = tmp();
  const db = createDb({ file: path.join(dir, 'h.db') });
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  let checked = 0;
  for (const table of tables) {
    for (const col of db.all(`PRAGMA table_info(${table})`)) {
      if (!/(rial|x100|x1000|pct)/.test(col.name)) continue;
      assert.match(col.type, /^INTEGER/i, `${table}.${col.name} must be INTEGER, got ${col.type}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 25, `only ${checked} money columns found — did the schema change?`);
  db.run("INSERT INTO accounts (name, type, opening_balance_rial, is_default, created_at) VALUES ('صندوق','cash',12,1,'2026-01-01T00:00:00Z')");
  assert.equal(db.get('SELECT typeof(opening_balance_rial) AS t FROM accounts').t, 'integer');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a read-only database can be opened for viewing without migrating', () => {
  const dir = tmp();
  const file = path.join(dir, 'i.db');
  const rw = createDb({ file });
  rw.close();
  const size = fs.statSync(file).size;
  const ro = createDb({ file, readonly: true });
  assert.equal(ro.readonly, true);
  assert.equal(fs.statSync(file).size, size, 'opening read-only must not rewrite the file');
  assert.equal(ro.get('SELECT COUNT(*) AS n FROM products').n, 0);
  ro.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultDbFile honours HYPER_SINA_DB and falls back to the data directory', () => {
  const saved = process.env.HYPER_SINA_DB;
  try {
    process.env.HYPER_SINA_DB = '/somewhere/else/my.db';
    assert.equal(defaultDbFile(), '/somewhere/else/my.db');
    delete process.env.HYPER_SINA_DB;
    assert.match(defaultDbFile(), /hyper-sina\.db$/);
  } finally {
    if (saved === undefined) delete process.env.HYPER_SINA_DB;
    else process.env.HYPER_SINA_DB = saved;
  }
});
