// Hyper Sina — application shell: bootstrap, auth gate, navigation, router.
import { api, setCsrf, ApiError } from './api.js';
import { el, clear, toFa, toast, jalaliText, periodLabel } from './util.js';

export const state = {
  me: null,
  csrf: null,
  settings: {},
  clock: {},
  counts: {},
  needsSetup: false,
  range: JSON.parse(localStorage.getItem('hs.range') || '{"mode":"month"}'),
  setRange(r) {
    this.range = r;
    localStorage.setItem('hs.range', JSON.stringify(r));
  },
};

const NAV = [
  { path: '#/', label: 'داشبورد', icon: '🏠', tab: true },
  { path: '#/sales', label: 'ثبت فروش', icon: '🧾', tab: true },
  { path: '#/purchases', label: 'خرید و موجودی', icon: '📦', tab: true },
  { path: '#/expenses', label: 'هزینه‌ها', icon: '💸', tab: true },
  { path: '#/accounts', label: 'صندوق و حساب‌ها', icon: '💰' },
  { path: '#/fx', label: 'دلار و تورم', icon: '💵', tab: true },
  { path: '#/pnl', label: 'سود و زیان', icon: '📊' },
  { path: '#/reports/monthly', label: 'گزارش‌های ماهانه', icon: '🗓️' },
  { path: '#/reports/yearly', label: 'گزارش‌های سالانه', icon: '📅' },
  { path: '#/real-profit', label: 'سود واقعی و اثر تورم', icon: '🔎' },
  { path: '#/settings', label: 'تنظیمات', icon: '⚙️', tab: true },
];

const VIEWS = {
  '#/': () => import('./views/dashboard.js'),
  '#/sales': () => import('./views/sales.js'),
  '#/purchases': () => import('./views/purchases.js'),
  '#/expenses': () => import('./views/expenses.js'),
  '#/accounts': () => import('./views/accounts.js'),
  '#/fx': () => import('./views/fx.js'),
  '#/pnl': () => import('./views/pnl.js'),
  '#/real-profit': () => import('./views/realprofit.js'),
  '#/reports/monthly': () => import('./views/reports.js'),
  '#/reports/yearly': () => import('./views/reports.js'),
  '#/reports/snapshots': () => import('./views/reports.js'),
  '#/settings': () => import('./views/settings.js'),
};

const app = document.getElementById('app');
const boot = document.getElementById('boot');

async function main() {
  let data;
  try {
    data = await api('/api/bootstrap');
  } catch (err) {
    clear(boot);
    boot.appendChild(el('p', { text: 'ارتباط با سرور برقرار نشد. لطفاً صفحه را تازه‌سازی کنید.' }));
    return;
  }
  state.settings = data.settings || {};
  state.clock = data.clock || {};
  state.counts = data.counts || {};
  state.needsSetup = data.needs_setup;
  state.meta = data.app;
  state.expenseCategories = data.expense_categories || [];
  state.paymentMethods = data.payment_methods || [];
  state.adjustmentReasons = data.adjustment_reasons || {};
  if (data.user) {
    state.me = data.user;
    state.csrf = data.csrf;
    setCsrf(data.csrf);
  }
  boot.hidden = true;
  app.hidden = false;
  if (!state.me) return renderAuth();
  renderShell();
  window.addEventListener('hashchange', route);
  route();
}

/* ------------------------------------------------------------------- auth -- */
async function renderAuth() {
  const view = await import('./views/auth.js');
  clear(app).appendChild(await view.render({ state, onDone: main, needsSetup: state.needsSetup }));
}

/* ------------------------------------------------------------------ shell -- */
function renderShell() {
  clear(app);
  const shell = el('div', { class: 'shell' });
  const rail = el('aside', { class: 'rail' });
  rail.appendChild(
    el('div', { class: 'brand' }, [
      el('div', { class: 'logo', text: 'هـ' }),
      el('div', {}, [el('b', { style: 'font-size:15px', text: 'هایپر سینا' }), el('div', { style: 'font-size:10.5px;opacity:.7', text: 'حسابداری شخصی فروشگاه' })]),
    ]),
  );
  const linkFor = (n) =>
    el('a', { href: n.path, 'data-nav': n.path, title: n.label }, [el('span', { 'aria-hidden': 'true', text: n.icon }), el('span', { text: n.label })]);
  rail.appendChild(el('nav', {}, NAV.map(linkFor)));
  rail.appendChild(
    el('div', { class: 'section', text: 'کاربر' }),
    el('div', { style: 'font-size:12px;opacity:.85;padding:0 6px 10px' }, [
      el('div', { text: state.me.display_name || state.me.username }),
      el('div', { style: 'opacity:.7;font-size:11px', text: state.me.role === 'owner' ? 'مالک — دسترسی کامل' : state.me.role === 'staff' ? 'کارمند — ثبت تراکنش' : 'فقط مشاهده' }),
    ]),
    el('a', { href: '#/', onclick: logout, style: 'color:#ffd9d9' }, [el('span', { text: '⎋' }), el('span', { text: 'خروج از حساب' })]),
  );

  const content = el('div', { class: 'content' });
  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'logo', text: 'هـ' }),
    el('div', { style: 'min-width:0' }, [
      el('h1', { text: 'هایپر سینا' }),
      el('span', { class: 'sub', text: `${state.clock.today_label || jalaliText(state.clock.today)} • ${toFa(state.clock.today || '')}` }),
    ]),
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'period-chip',
      id: 'range-chip',
      type: 'button',
      onclick: openRangePicker,
      text: 'این ماه',
    }),
  ]);
  const mainEl = el('main', { id: 'view' });
  content.appendChild(topbar);
  content.appendChild(mainEl);

  const tabs = el('nav', { class: 'tabbar' });
  tabs.appendChild(
    el('a', { href: '#/', 'data-nav': '#/' }, [el('span', { class: 'ico', text: '🏠' }), el('span', { text: 'داشبورد' })]),
  );
  tabs.appendChild(el('a', { href: '#/sales', 'data-nav': '#/sales' }, [el('span', { class: 'ico', text: '🧾' }), el('span', { text: 'فروش' })]));
  tabs.appendChild(el('a', { href: '#/purchases', 'data-nav': '#/purchases' }, [el('span', { class: 'ico', text: '📦' }), el('span', { text: 'خرید' })]));
  tabs.appendChild(el('a', { href: '#/expenses', 'data-nav': '#/expenses' }, [el('span', { class: 'ico', text: '💸' }), el('span', { text: 'هزینه' })]));
  tabs.appendChild(
    el('a', { href: '#/more', id: 'more-btn' }, [el('span', { class: 'ico', text: '☰' }), el('span', { text: 'بیشتر' })]),
  );
  document.getElementById('more-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    openMoreSheet();
  });

  shell.appendChild(rail);
  shell.appendChild(content);
  app.appendChild(shell);
  app.appendChild(tabs);
}

function openMoreSheet() {
  const dlg = el('dialog');
  dlg.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: 'بخش‌های دیگر' })]));
  const grid = el('div', { class: 'card-b grid cols-2', style: 'gap:8px' });
  for (const n of NAV.filter((x) => !['#/', '#/sales', '#/purchases', '#/expenses'].includes(x.path))) {
    grid.appendChild(
      el('a', {
        href: n.path,
        class: 'btn ghost',
        style: 'justify-content:flex-start',
        onclick: () => dlg.close(),
      }, [el('span', { text: n.icon }), el('span', { text: n.label })]),
    );
  }
  dlg.appendChild(grid);
  dlg.appendChild(
    el('div', { class: 'card-b', style: 'display:flex;gap:8px' }, [
      el('button', { class: 'btn ghost', text: 'بستن', onclick: () => dlg.close() }),
      el('button', { class: 'btn danger', text: 'خروج', onclick: () => { dlg.close(); logout(); } }),
    ]),
  );
  document.getElementById('modal-root').appendChild(dlg);
  dlg.showModal();
}

export function openRangePicker() {
  const opts = [
    { mode: 'today', label: 'امروز' },
    { mode: 'month', label: 'این ماه' },
    { mode: 'prev', label: 'ماه قبل' },
    { mode: 'year', label: 'امسال' },
    { mode: 'custom', label: 'بازهٔ دلخواه' },
  ];
  const dlg = el('dialog');
  dlg.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: 'انتخاب بازهٔ زمانی' })]));
  const body = el('div', { class: 'card-b grid' });
  const chips = el('div', { class: 'chips' });
  let chosen = state.range.mode || 'month';
  for (const o of opts) {
    chips.appendChild(
      el('button', {
        class: 'chip',
        type: 'button',
        'aria-pressed': String(chosen === o.mode),
        text: o.label,
        onclick: (e) => {
          chosen = o.mode;
          for (const c of chips.children) c.setAttribute('aria-pressed', 'false');
          e.currentTarget.setAttribute('aria-pressed', 'true');
          custom.hidden = o.mode !== 'custom';
        },
      }),
    );
  }
  const from = el('input', { class: 'control', type: 'date', value: state.range.from || state.clock.today });
  const to = el('input', { class: 'control', type: 'date', value: state.range.to || state.clock.today });
  const custom = el('div', { class: 'grid cols-2', hidden: state.range.mode !== 'custom' }, [
    el('div', { class: 'field' }, [el('label', { text: 'از تاریخ' }), from]),
    el('div', { class: 'field' }, [el('label', { text: 'تا تاریخ' }), to]),
  ]);
  body.appendChild(chips);
  body.appendChild(custom);
  body.appendChild(
    el('div', { class: 'btn-row' }, [
      el('button', {
        class: 'btn',
        text: 'اعمال',
        onclick: () => {
          state.setRange(chosen === 'custom' ? { mode: 'custom', from: from.value, to: to.value } : { mode: chosen });
          dlg.close();
          updateRangeChip();
          route();
        },
      }),
      el('button', { class: 'btn ghost', text: 'انصراف', onclick: () => dlg.close() }),
    ]),
  );
  dlg.appendChild(body);
  document.getElementById('modal-root').appendChild(dlg);
  dlg.showModal();
}

export function updateRangeChip() {
  const chip = document.getElementById('range-chip');
  if (!chip) return;
  const labels = { today: 'امروز', month: 'این ماه', prev: 'ماه قبل', year: 'امسال', custom: 'بازهٔ دلخواه' };
  const r = state.range;
  chip.textContent = r.mode === 'custom' ? `${toFa(r.from || '')} تا ${toFa(r.to || '')}` : labels[r.mode] || 'این ماه';
}

/** Query string fragment for the currently selected period. */
export function rangeParams() {
  const r = state.range;
  if (r.mode === 'custom' && r.from && r.to) return `from=${r.from}&to=${r.to}`;
  return `range=${r.mode || 'month'}`;
}

export function currentPeriod() {
  // Jalali period for report views, derived from the selected range
  const r = state.range;
  if (r.period) return r.period;
  if (r.mode === 'custom' && r.to) return jalaliPeriodOf(r.to);
  if (r.mode === 'prev') return shiftJalaliPeriod(state.clock.today_period, -1);
  return state.clock.today_period;
}
export function currentYear() {
  const r = state.range;
  if (r.year) return r.year;
  if (r.mode === 'custom' && r.to) return jalaliPeriodOf(r.to).slice(0, 4);
  return state.clock.this_year;
}
function jalaliPeriodOf(iso) {
  try {
    const p = new Intl.DateTimeFormat('en-CA-u-ca-persian', { year: 'numeric', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
    const m = /(\d{4})-(\d{2})/.exec(p.replace(' AP', '').replace(' AP', ''));
    if (m) return `${m[1]}-${m[2]}`;
  } catch {}
  return state.clock.today_period;
}
function shiftJalaliPeriod(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  let ny = y;
  let nm = m + delta;
  while (nm < 1) { nm += 12; ny -= 1; }
  while (nm > 12) { nm -= 12; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
export { shiftJalaliPeriod as shiftPeriod, periodLabel, jalaliPeriodOf };

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {}
  state.me = null;
  toast('از حساب خارج شدید.');
  renderAuth();
}

export async function route() {
  const hash = location.hash || '#/';
  const path = hash.split('?')[0];
  const host = document.getElementById('view');
  if (!host) return;
  const key = VIEWS[path] ? path : path.startsWith('#/reports/') ? '#/reports/monthly' : '#/';
  if (key === '#/reports/yearly' || path === '#/reports/yearly') {
    // handled by the same module through its own router
  }
  for (const a of document.querySelectorAll('[data-nav]')) {
    const active = a.getAttribute('data-nav') === (key === '#/' ? '#/' : path.startsWith('#/reports') ? key : key);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  updateRangeChip();
  clear(host);
  host.appendChild(el('div', { class: 'grid' }, [el('div', { class: 'skeleton' }), el('div', { class: 'skeleton', style: 'height:120px' })]));
  try {
    const mod = await VIEWS[key]();
    await mod.render(host, { state, refresh: route, params: new URLSearchParams(hash.split('?')[1] || ''), path });
  } catch (err) {
    clear(host).appendChild(
      el('div', { class: 'card' }, [
        el('div', { class: 'card-b' }, [
          el('h3', { text: 'این بخش بارگذاری نشد' }),
          el('p', { class: 'notice bad', text: err instanceof ApiError ? err.message : 'خطای غیرمنتظره. دوباره تلاش کنید.' }),
          el('button', { class: 'btn', text: 'تلاش دوباره', onclick: route }),
        ]),
      ]),
    );
  }
  window.scrollTo({ top: 0 });
}

/** Re-render the active view (used after a successful save). */
export const refresh = () => route();

main();
