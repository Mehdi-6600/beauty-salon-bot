/**
 * Hyper Sina — authentication, sessions, CSRF and authorization.
 *
 * Financial writes are only ever executed server-side after `requireRole()`
 * passes; the client never holds a DB connection or a secret. Passwords use
 * scrypt (node:crypto) with a per-user salt; session tokens are random 256-bit
 * values stored only as SHA-256 hashes in the database, so a DB dump cannot be
 * replayed as a session and sessions can be revoked.
 */

import crypto from 'node:crypto';
import { HttpError, cookieHeader } from './http.js';

export const SESSION_COOKIE = 'hs_session';
export const SESSION_DAYS = Number(process.env.HYPER_SINA_SESSION_DAYS || 30);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const candidate = crypto.scryptSync(password, Buffer.from(salt, 'base64'), Buffer.from(key, 'base64').length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(candidate, Buffer.from(key, 'base64'));
  } catch {
    return false;
  }
}

export function passwordProblems(password, username = '') {
  const pw = String(password ?? '');
  if (pw.length < 8) return 'رمز عبور باید حداقل ۸ نویسه باشد.';
  if (pw.length > 200) return 'رمز عبور خیلی بلند است.';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'رمز عبور نباید همان نام کاربری باشد.';
  if (/^(12345678|password|123456789|11111111)$/i.test(pw)) return 'این رمز عبور خیلی رایج و ضعیف است.';
  return null;
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('hex');

export function createSession(db, user, { userAgent = '' } = {}) {
  const token = randomToken();
  const csrf = randomToken().slice(0, 32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, csrf, user_agent) VALUES (?,?,?,?,?,?)', [
    sha256(token),
    user.id,
    new Date().toISOString(),
    expires,
    csrf,
    String(userAgent).slice(0, 200),
  ]);
  return { token, csrf, expiresAt: expires };
}

export function destroySession(db, token) {
  if (!token) return;
  db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export function destroyAllSessions(db, userId) {
  db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export function setSessionCookie(res, token, { secure = false } = {}) {
  res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, secure }));
}

export function clearSessionCookie(res) {
  res.setHeader('set-cookie', cookieHeader(SESSION_COOKIE, '', { maxAge: 0 }));
}

export function authenticate(db, req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db.get(
    `SELECT s.token_hash, s.expires_at, s.csrf, u.id, u.username, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    [sha256(token)],
  );
  if (!row) return null;
  if (row.expires_at <= new Date().toISOString()) {
    destroySession(db, token);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role, csrf: row.csrf, tokenHash: row.token_hash };
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** All roles that may read; 'readonly' is allowed here, writes are checked separately. */
export function requireUser(ctx) {
  if (!ctx.user) throw new HttpError(401, 'برای ادامه وارد حساب شوید.');
  return ctx.user;
}

export function requireRole(ctx, ...roles) {
  const user = requireUser(ctx);
  if (!roles.includes(user.role)) {
    throw new HttpError(403, `این عملیات نیازمند دسترسی «${roles.join(' یا ')}» است.`);
  }
  return user;
}

export const WRITE_ROLES = ['owner', 'staff'];
export const ADMIN_ROLES = ['owner'];

/** Double-submit CSRF: required on every mutating request. */
export function requireCsrf(ctx) {
  requireUser(ctx);
  const sent = String(ctx.req.headers['x-csrf-token'] || ctx.body?._csrf || '');
  if (!sent || sent !== ctx.user.csrf) throw new HttpError(403, 'توکن CSRF نامعتبر یا منقضی است. صفحه را تازه‌سازی کنید.');
  return true;
}

/* ------------------------------------------------------------- throttling -- */

const attempts = new Map();

export function throttle(key, { max = 8, windowMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();
  const rec = attempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (rec.resetAt <= now) {
    rec.count = 0;
    rec.resetAt = now + windowMs;
  }
  rec.count += 1;
  attempts.set(key, rec);
  if (rec.count > max) {
    const waitMin = Math.max(1, Math.ceil((rec.resetAt - now) / 60000));
    throw new HttpError(429, `تلاش ناموفق زیاد بود. لطفاً ${waitMin} دقیقه بعد دوباره امتحان کنید.`, { retry_after_minutes: waitMin });
  }
  return rec;
}

export function throttleClear(key) {
  attempts.delete(key);
}

export function userFromRow(row) {
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
}
