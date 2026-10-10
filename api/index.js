/**
 * Vercel Node.js serverless entry point for Hyper Sina (هایپر سینا).
 *
 * It reuses the exact same handler as `server/index.js`, so there is only one
 * code path to test. Persistence note (important): the serverless filesystem is
 * read-only except `/tmp`, so SQLite here is per-instance and temporary. Set
 * `HYPER_SINA_DB` to a mounted path when running on platform storage, or plug a
 * persistent database driver into `server/db.js` for serverless persistence
 * (see docs/DEPLOY.md).
 */

import { createDb } from '../server/db.js';
import { createHandler } from '../server/app.js';

let cached = null;

function bootstrap() {
  if (cached) return cached;
  const file = process.env.HYPER_SINA_DB || `${process.env.HYPER_SINA_DATA_DIR || '/tmp'}/hyper-sina.db`;
  const db = createDb({ file });
  cached = createHandler(db);
  cached.__db = db;
  return cached;
}

export default async function handler(req, res) {
  const h = bootstrap();
  return h(req, res);
}
