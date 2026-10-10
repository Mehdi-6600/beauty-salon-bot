// Hyper Sina — shared UI helpers (formatting, DOM, dialogs).
const FA = '۰۱۲۳۴۵۶۷۸۹';

export function toFa(str) {
  return String(str).replace(/\d/g, (d) => FA[+d]);
}
export function toEn(str) {
  return String(str)
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
export function group(n) {
  const s = String(Math.trunc(n)).replace(/-/g, '');
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
}
/** Parse user input (Persian digits, separators, spaces) → Number or NaN. */
export function parseNum(v) {
  const s = toEn(v).replace(/[\s٬,_]/g, '').replace(/[٫،]/g, '.').replace(/(تومان|ریال|ریال|Tom|toman|rial)/gi, '');
  if (s === '' || s === '-') return NaN;
  if (!/^-?\d*(\.\d*)?$/.test(s)) return NaN;
  return Number(s);
}

export const RIAL_PER_TOMAN = 10;

/** rial (integer) → display string in the chosen unit, with unit label. */
export function money(rial, { unit = 'toman', sign = 'auto', withUnit = true, digits = 'fa' } = {}) {
  const v = Math.trunc(Number(rial) || 0);
  const shown = unit === 'rial' ? v : Math.round(v / RIAL_PER_TOMAN);
  const abs = Math.abs(shown);
  let s = group(abs);
  if (v < 0) s = sign === 'paren' ? `(${s})` : `−${s}`;
  if (digits === 'en') return s + (withUnit ? ` ${unit === 'rial' ? 'ریال' : 'تومان'}` : '');
  return toFa(s) + (withUnit && withUnit !== 'none' ? ` ${unit === 'rial' ? 'ریال' : 'تومان'}` : '');
}

export function tomanValue(rial) {
  return Math.round((Number(rial) || 0) / RIAL_PER_TOMAN);
}

export function qty(q, { unit = '', digits = 'fa' } = {}) {
  const v = Number(q) / 1000;
  const s = Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  return `${digits === 'fa' ? toFa(s) : s}${unit ? ` ${unit}` : ''}`;
}

/** pct_x100 (integer, percent×100) → "+۱۲٫۵٪" */
export function pct(pctX100, { signed = true, digits = 'fa' } = {}) {
  if (pctX100 === null || pctX100 === undefined || Number.isNaN(pctX100)) return '—';
  const v = Number(pctX100) / 100;
  const body = Math.abs(v).toFixed(2).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const sign = v < 0 ? '−' : signed ? '+' : '';
  const s = `${sign}${body.replace('.', '٫')}`;
  return digits === 'fa' ? `${toFa(s.replace('−', '-')).replace('-', '−')}٪` : `${s}٪`;
}

export function rate(x100, { digits = 'fa', unit = 'تومان' } = {}) {
  if (x100 === null || x100 === undefined) return '—';
  const v = Number(x100) / 100;
  const s = group(Math.round(v));
  return `${digits === 'fa' ? toFa(s) : s} ${unit}`;
}

export function dateTimeLabel(iso, { digits = 'fa' } = {}) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const time = m[4] ? ` - ${toFa(`${m[4]}:${m[5]}`)}` : '';
  return `${jalaliText(`${m[1]}-${m[2]}-${m[3]}`, { digits })}${time}`;
}

/** Browser-side Jalali formatting (ICU is available in all current browsers). */
export function jalaliText(isoDate, { digits = 'fa', style = 'long' } = {}) {
  if (!isoDate) return '';
  const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(isoDate);
  try {
    const opts = style === 'short' ? { year: 'numeric', month: '2-digit', day: '2-digit' } : { day: 'numeric', month: 'long', year: 'numeric' };
    const s = new Intl.DateTimeFormat(`${digits === 'fa' ? 'fa-IR' : 'en-US'}-u-ca-persian`, { ...opts, timeZone: 'UTC' }).format(d);
    return digits === 'fa' ? s : s;
  } catch {
    return String(isoDate);
  }
}

export function monthNameFa(i, { digits = 'fa' } = {}) {
  const names = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
  const n = names[(Number(i) - 1 + 12) % 12];
  return n;
}

export function shiftPeriod(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  let ny = y;
  let nm = m + delta;
  while (nm < 1) { nm += 12; ny -= 1; }
  while (nm > 12) { nm -= 12; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function periodLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return String(period || '');
  return toFa(`${monthNameFa(m[2])} ${m[1]}`);
}

/* ------------------------------------------------------------------- dom -- */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected') node[k] = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children === undefined || children === null ? [] : children)) {
    if (c === false || c === null || c === undefined) continue;
    node.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return node;
}
export const frag = (children) => {
  const f = document.createDocumentFragment();
  for (const c of [].concat(children)) if (c) f.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  return f;
};
export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

/* --------------------------------------------------------------- feedback -- */

export function toast(message, { type = 'ok', timeout = 3600 } = {}) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = el('div', { class: `toast ${type === 'err' ? 'err' : ''}`, text: message });
  host.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, timeout);
}

/** Modal with optional typed confirmation. Resolves true when confirmed. */
export function dialog({ title, body, confirmText = 'تأیید', cancelText = 'انصراف', danger = false, requireText = null, fields = [] }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const dlg = el('dialog', { class: 'modal' });
    const inputs = fields.map((f) => {
      const i = el(f.multiline ? 'textarea' : 'input', { class: 'control', name: f.name, placeholder: f.placeholder || '', rows: f.multiline ? 3 : undefined });
      return { ...f, node: i };
    });
    const gate = requireText ? el('input', { class: 'control', placeholder: `برای تأیید بنویسید: ${requireText}` }) : null;
    const okBtn = el('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', disabled: !!requireText, text: confirmText });
    dlg.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: title })]));
    dlg.appendChild(
      el('div', { class: 'card-b' }, [
        body ? el('div', { class: 'notice' + (danger ? ' bad' : ''), html: typeof body === 'string' ? body : undefined, text: typeof body === 'string' ? undefined : body }) : null,
        ...inputs.map((i) => el('div', { class: 'field' }, [el('label', { text: i.label }), i.node, i.hint ? el('div', { class: 'hint', text: i.hint }) : null])),
        gate
          ? el('div', { class: 'field' }, [el('label', { text: 'تأیید نهایی' }), gate, el('div', { class: 'hint', text: `این عمل قابل بازگشت نیست.` })])
          : null,
      ]),
    );
    dlg.appendChild(el('div', { class: 'card-b', style: 'display:flex;gap:8px;justify-content:flex-start' }, [
      okBtn,
      el('button', { class: 'btn ghost', type: 'button', text: cancelText, onclick: () => { dlg.close(); resolve(false); } }),
    ]));
    if (gate) gate.addEventListener('input', () => (okBtn.disabled = gate.value.trim() !== requireText));
    okBtn.addEventListener('click', () => {
      const values = {};
      for (const i of inputs) {
        const v = i.node.value.trim();
        if (i.required && !v) {
          i.node.classList.add('invalid');
          i.node.focus();
          return;
        }
        values[i.name] = v;
      }
      dlg.close();
      resolve({ ok: true, values });
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(false);
    });
    root.appendChild(dlg);
    dlg.showModal();
    (inputs[0]?.node || gate || okBtn).focus?.();
  });
}

export function loading(container, text = 'در حال بارگذاری…') {
  clear(container).appendChild(
    el('div', { class: 'card' }, [el('div', { class: 'card-b' }, [el('div', { class: 'skeleton' }), el('div', { class: 'skeleton', style: 'margin-top:8px;height:44px' })])]),
  );
}

export function emptyState({ icon = '🗂️', title, body, action }) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'empty' }, [
      el('div', { class: 'ico', text: icon }),
      el('h3', { style: 'margin:6px 0 0;font-size:15px', text: title }),
      body ? el('p', { text: body }) : null,
      action || null,
    ]),
  ]);
}

export function badge(text, kind = '') {
  return el('span', { class: `badge ${kind}`, text });
}

export function card(title, bodyNode, { actions = [], subtitle = null, cls = '' } = {}) {
  const head = title
    ? el('div', { class: 'card-h' }, [el('h2', { text: title }), subtitle ? el('span', { class: 'hint', style: 'margin:0', text: subtitle }) : null, el('span', { class: 'spacer' }), ...actions])
    : null;
  return el('section', { class: `card ${cls}` }, [head, el('div', { class: 'card-b' }, [bodyNode])]);
}

export async function withBusy(btn, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span>در حال ذخیره…</span>';
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
