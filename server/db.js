/**
 * Hyper Sina — persistence layer.
 *
 * The driver is deliberately tiny and synchronous (better for accounting: a
 * single SQLite file, transactions with `BEGIN IMMEDIATE`, no connection pool
 * and no partial-write surprises). `createDb()` returns an object with
 * `.all/.get/.run/.exec/.tx/.client`, which is the only surface the rest of the
 * app uses — so a Postgres/Turso driver can be swapped in for serverless
 * deployments without touching business logic (see docs/DEPLOY.md).
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export function defaultDbFile() {
  if (process.env.HYPER_SINA_DB) return process.env.HYPER_SINA_DB;
  const base = process.env.HYPER_SINA_DATA_DIR || path.join(path.dirname(__dirname), 'data');
  return path.join(base, 'hyper-sina.db');
}

function applyPragmas(sqlite) {
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA synchronous = NORMAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 5000');
}

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
}

export function migrate(sqlite, dir = MIGRATIONS_DIR) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  )`);
  const done = new Set(sqlite.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const applied = [];
  const insert = sqlite.prepare('INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)');
  for (const file of listMigrations(dir)) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
    if (done.has(file)) {
      const prev = sqlite.prepare('SELECT checksum FROM schema_migrations WHERE name = ?').get(file);
      if (prev && prev.checksum !== checksum) {
        throw new Error(`migration ${file} was edited after being applied (checksum drift) — add a new migration instead`);
      }
      continue;
    }
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      sqlite.exec(sql);
      insert.run(file, new Date().toISOString(), checksum);
      sqlite.exec('COMMIT');
      applied.push(file);
    } catch (err) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {}
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
  return applied;
}

export function createDb({ file = defaultDbFile(), readonly = false } = {}) {
  if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new DatabaseSync(file, { readOnly: readonly, open: true });
  if (!readonly) {
    applyPragmas(sqlite);
    migrate(sqlite);
  }

  let depth = 0;

  const client = {
    file,
    driver: 'sqlite',
    readonly: !!readonly,
    all(sql, params = []) {
      return sqlite.prepare(sql).all(...toArgs(params));
    },
    get(sql, params = []) {
      return sqlite.prepare(sql).get(...toArgs(params)) ?? null;
    },
    run(sql, params = []) {
      const r = sqlite.prepare(sql).run(...toArgs(params));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    exec(sql) {
      sqlite.exec(sql);
    },
    /** Run fn inside a transaction; supports nesting via savepoints. */
    tx(fn) {
      if (depth === 0) {
        sqlite.exec('BEGIN IMMEDIATE');
        depth = 1;
        try {
          const out = fn(client);
          sqlite.exec('COMMIT');
          depth = 0;
          return out;
        } catch (err) {
          try {
            sqlite.exec('ROLLBACK');
          } catch {}
          depth = 0;
          throw err;
        }
      }
      const sp = `sp_${depth}_${crypto.randomBytes(4).toString('hex')}`;
      sqlite.exec(`SAVEPOINT ${sp}`);
      depth += 1;
      try {
        const out = fn(client);
        sqlite.exec(`RELEASE ${sp}`);
        depth -= 1;
        return out;
      } catch (err) {
        sqlite.exec(`ROLLBACK TO ${sp}`);
        sqlite.exec(`RELEASE ${sp}`);
        depth -= 1;
        throw err;
      }
    },
    close() {
      sqlite.close();
    },
    sqlite,
  };

  return client;
}

/** node:sqlite binds only null/string/number/bigint/Buffer — normalise the rest. */
function toArgs(params) {
  const list = Array.isArray(params) ? params : Object.values(params);
  return list.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
}

/** Idempotency guard: returns the existing row id if the dedupe key was seen. */
export function dedupeConflict(err) {
  const msg = String(err?.message || err || '');
  return /UNIQUE constraint failed:.*(dedupe_key)/i.test(msg);
}
