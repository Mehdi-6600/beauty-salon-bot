/**
 * Hyper Sina (هایپر سینا) — local / container entry point.
 * Run: `npm start`  (PORT=3000 by default, HYPER_SINA_DB to point at the data file)
 */

import http from 'node:http';
import { createDb, defaultDbFile } from './db.js';
import { createHandler } from './app.js';
import { shopNow } from './calendar.js';

const file = defaultDbFile();
const db = createDb({ file });
const handler = createHandler(db);
const server = http.createServer(handler);

const port = Number(process.env.PORT || 3000);
const host = process.env.HYPER_SINA_HOST || '0.0.0.0';

server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(port, host, () => {
  const now = shopNow();
  const users = db.get('SELECT COUNT(*) AS n FROM users').n;
  process.stdout.write(
    [
      '',
      `  هایپر سینا (Hyper Sina) — حسابداری شخصی فروشگاه`,
      `  ➜  Local:    http://localhost:${port}`,
      `  ➜  Network:  http://${host}:${port}`,
      `  ➜  DB:       ${file} (driver: ${db.driver})`,
      `  ➜  امروز:     ${now.jalali.date} (${now.date}) ${now.tz}`,
      users === 0 ? '  ➜  وضعیت:    نیازمند ساخت حساب کاربری مالک (صفحهٔ نخست را باز کنید)' : `  ➜  وضعیت:    آماده — ${users} کاربر ثبت‌شده`,
      '',
    ].join('\n'),
  );
});

function shutdown(signal) {
  process.stdout.write(`\n  ${signal} — در حال بستن امن سرور…\n`);
  server.close(() => {
    try {
      db.close();
    } catch {}
    process.exit(0);
  });
  // give in-flight accounting transactions a moment, then force
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
