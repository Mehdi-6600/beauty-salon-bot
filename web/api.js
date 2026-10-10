// Hyper Sina — API client. Adds the CSRF header, surfaces server validation
// messages, and attaches an idempotency key to every new record so a double
// tap on «ذخیره» can never create two ledger rows.
let csrf = null;
const keyCache = new Map();

export function setCsrf(token) {
  csrf = token;
}

export function newKey(slot = 'default') {
  const uuid = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/-/g, '');
  return `${slot}-${uuid}`.slice(0, 60);
}

/** Same key until consumed by a successful save — protects against resubmits. */
export function stickyKey(slot) {
  if (!keyCache.has(slot)) keyCache.set(slot, newKey(slot));
  return keyCache.get(slot);
}
export function releaseKey(slot) {
  keyCache.delete(slot);
}

export class ApiError extends Error {
  constructor(message, { status = 0, details = null } = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['x-csrf-token'] = csrf || '';
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) {
    if (!res.ok) throw new ApiError('دریافت فایل ناموفق بود.', { status: res.status });
    return res.blob();
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('پاسخ سرور قابل خواندن نیست.', { status: res.status });
  }
  if (!res.ok) {
    throw new ApiError(data?.error || 'خطا در ارتباط با سرور.', { status: res.status, details: data?.details });
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path, body) => api(path, { method: 'DELETE', body });

export function downloadUrl(path) {
  return path;
}
