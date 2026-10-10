/**
 * Hyper Sina — minimal HTTP plumbing (zero dependencies).
 * The exported `handler(req, res)` works both behind `node:http` locally and
 * as a Vercel Node.js serverless function, so there is exactly one code path.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmountToRial } from './money.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.join(__dirname, '..', 'web');

export class HttpError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const badRequest = (message, details) => new HttpError(400, message, details);
export const forbidden = (message = 'دسترسی غیرمجاز است.') => new HttpError(403, message);
export const notFound = (message = 'یافت نشد.') => new HttpError(404, message);
export const conflict = (message, details) => new HttpError(409, message, details);

export function readBody(req, limitBytes = 1_500_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new HttpError(413, 'حجم ارسالی بیش از حد مجاز است.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest('بدنهٔ درخواست معتبر نیست (JSON انتظار می‌رفت).');
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { maxAge = null, httpOnly = true, sameSite = 'Strict', secure = false, path: p = '/' } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`];
  if (httpOnly) bits.push('HttpOnly');
  if (secure) bits.push('Secure');
  if (maxAge !== null) bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
}

export function sendJson(res, status, payload, headers = {}) {
  // The engine does its math in BigInt; JSON cannot carry it. Converting at the
  // boundary keeps exact arithmetic inside and a readable number outside.
  const body = Buffer.from(JSON.stringify(payload ?? null, (k, v) => (typeof v === 'bigint' ? Number(v) : v)), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const staticCache = new Map();

export function serveStatic(res, relPath, { immutable = false } = {}) {
  const clean = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(WEB_ROOT, clean);
  if (!file.startsWith(WEB_ROOT)) throw notFound();
  let entry = staticCache.get(file);
  if (!entry || process.env.NODE_ENV === 'development') {
    try {
      const buf = fs.readFileSync(file);
      entry = { body: buf, mtime: fs.statSync(file).mtimeMs, type: MIME[path.extname(file)] || 'application/octet-stream' };
      staticCache.set(file, entry);
    } catch {
      return false;
    }
  }
  res.writeHead(200, {
    'content-type': entry.type,
    'content-length': entry.body.length,
    etag: `W/"${Math.round(entry.mtime).toString(36)}"`,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(entry.body);
  return true;
}

/** Tiny pattern router: `route('GET', '/api/sales/:id')`. */
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, options = {}) => {
    const keys = [];
    const re = new RegExp(
      `^${pattern
        .split('/')
        .map((seg) => {
          if (seg.startsWith(':')) {
            keys.push(seg.slice(1));
            return '([^/]+)';
          }
          if (seg === '*') {
            keys.push('wildcard');
            return '(.*)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/')}$`,
    );
    routes.push({ method, re, keys, handler, options });
  };
  return {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    patch: (p, h, o) => add('PATCH', p, h, o),
    del: (p, h, o) => add('DELETE', p, h, o),
    match(method, pathname) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
      return null;
    },
    /** Same path but other methods — used for a correct 405. */
    methodMismatch(pathname) {
      const allowed = new Set();
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (m) allowed.add(r.method);
      }
      return allowed;
    },
  };
}

/* ------------------------------------------------------------ validation -- */

const isInt = (v) => Number.isSafeInteger(v);

export const V = {
  /** required whole number, bounded */
  int(field, { min = -Infinity, max = Infinity, required = true, label = field } = {}) {
    return (obj, mutate = false) => {
      let raw = obj[field];
      if (raw === undefined || raw === null || raw === '') {
        if (required) throw badRequest(`فیلد «${label}» الزامی است.`, { field });
        return undefined;
      }
      let n;
      if (typeof raw === 'number') n = raw;
      else {
        const cleaned = String(raw).trim();
        if (!/^-?\d+$/.test(cleaned)) throw badRequest(`فیلد «${label}» باید عدد صحیح باشد.`, { field });
        n = Number(cleaned);
      }
      if (!Number.isFinite(n) || !isInt(n)) throw badRequest(`فیلد «${label}» باید عدد صحیح و در محدودهٔ دقیق باشد.`, { field });
      const v = n;
      if (v < min || v > max) throw badRequest(`فیلد «${label}» خارج از بازهٔ مجاز است (${min} تا ${max}).`, { field });
      if (mutate) obj[field] = v;
      return v;
    };
  },
  text(field, { maxLength = 500, required = false, label = field, trim = true } = {}) {
    return (obj) => {
      let raw = obj[field];
      if (raw === undefined || raw === null) {
        if (required) throw badRequest(`فیلد «${label}» الزامی است.`, { field });
        return null;
      }
      let s = String(raw);
      if (trim) s = s.trim().replace(/\s+/g, ' ');
      if (!s.length) {
        if (required) throw badRequest(`فیلد «${label}» الزامی است.`, { field });
        return null;
      }
      if (s.length > maxLength) throw badRequest(`فیلد «${label}» حداکثر ${maxLength} نویسه مجاز است.`, { field });
      // control characters are never acceptable in a ledger note
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) throw badRequest(`فیلد «${label}» شامل نویسه‌های غیرمجاز است.`, { field });
      return s;
    };
  },
  oneOf(field, allowed, { required = true, label = field } = {}) {
    return (obj) => {
      const raw = obj[field];
      if (raw === undefined || raw === null || raw === '') {
        if (required) throw badRequest(`فیلد «${label}» الزامی است.`, { field });
        return null;
      }
      if (!allowed.includes(raw)) throw badRequest(`مقدار «${label}» نامعتبر است. مقادیر مجاز: ${allowed.join(', ')}`, { field });
      return raw;
    };
  },
  date(field = 'date', { required = true, label = 'تاریخ', future = 'reject' } = {}) {
    return (obj) => {
      const raw = obj[field];
      if (!raw) {
        if (required) throw badRequest(`فیلد «${label}» الزامی است.`, { field });
        return null;
      }
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).slice(0, 10));
      if (!m) throw badRequest(`قالب «${label}» باید YYYY-MM-DD باشد.`, { field });
      const d = new Date(`${m[0]}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[3])) {
        throw badRequest(`تاریخ «${label}» وجود ندارد.`, { field });
      }
      if (future === 'reject') {
        const today = new Date().toISOString().slice(0, 10);
        if (m[0] > today) throw badRequest(`تاریخ آینده قابل ثبت نیست (${m[0]}).`, { field });
      }
      return m[0];
    };
  },
  time(field = 'time', { label = 'ساعت' } = {}) {
    return (obj) => {
      const raw = obj[field];
      if (!raw) return null;
      const m = /^(\d{2}):(\d{2})/.exec(String(raw));
      if (!m) throw badRequest(`قالب «${label}» باید HH:MM باشد.`, { field });
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh > 23 || mm > 59) throw badRequest(`«${label}» نامعتبر است.`, { field });
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    };
  },
  jperiod(field = 'period', { required = true, label = 'دوره' } = {}) {
    return (obj) => {
      const raw = obj[field];
      if (!raw) {
        if (required) throw badRequest(`فیلد «${label}» الزامی است.`, { field });
        return null;
      }
      const s = String(raw).trim();
      if (/^\d{4}-\d{2}$/.test(s)) {
        const mm = Number(s.slice(5, 7));
        if (mm < 1 || mm > 12) throw badRequest(`ماه «${label}» نامعتبر است.`, { field });
        return s;
      }
      if (/^\d{4}$/.test(s)) return s;
      throw badRequest(`قالب «${label}» باید ۱۴۰۵-۰۲ (ماه) یا ۱۴۰۵ (سال) باشد.`, { field });
    };
  },
  uuid(field = 'dedupe_key', { required = false, label = 'کلید جلوگیری از تکرار' } = {}) {
    return (obj) => {
      const raw = obj[field];
      if (!raw) {
        if (required) throw badRequest(`فیلد «${label}» الزامی است.`, { field });
        return null;
      }
      const s = String(raw).trim();
      if (!/^[\w.-]{8,64}$/.test(s)) throw badRequest(`«${label}» نامعتبر است.`, { field });
      return s;
    };
  },
};

/**
 * Amount in whole rial, accepting the explicit unit the client sent
 * (`<x>_toman` XOR `<x>_rial`) — exactly one of the two is allowed so a
 * mis-scaled value can never be written.
 */
export function amountField(fields, { tomanField, rialField, required = true, min = 0, max = 9_000_000_000_000_000, label = 'مبلغ' }) {
  const toman = fields[tomanField];
  const rial = fields[rialField];
  if ((toman === undefined || toman === null || toman === '') && (rial === undefined || rial === null || rial === '')) {
    if (required) throw badRequest(`فیلد «${label}» الزامی است. واحد مبلغ (تومان یا ریال) را مشخص کنید.`, { field: tomanField });
    return null;
  }
  if (toman !== undefined && toman !== null && toman !== '' && rial !== undefined && rial !== null && rial !== '') {
    throw badRequest(`فقط یکی از دو فیلد «${tomanField}» یا «${rialField}» مجاز است.`, { field: rialField });
  }
  const rialValue = toman !== undefined && toman !== null && toman !== '' ? parseAmountToRial(toman, 'toman') : parseAmountToRial(rial, 'rial');
  if (rialValue === null) throw badRequest(`مبلغ «${label}» نامعتبر است (حداقل واحد پول ریال است؛ ۱ تومان = ۱۰ ریال).`, { field: tomanField });
  if (rialValue < min || rialValue > max) throw badRequest(`مبلغ «${label}» خارج از بازهٔ مجاز است.`, { field: tomanField });
  return rialValue;
}
