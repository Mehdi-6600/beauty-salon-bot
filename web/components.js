// Hyper Sina — reusable form controls and report blocks.
// Keeping the accounting statements in one component guarantees that the
// dashboard, the P&L page, the monthly report and a frozen snapshot all render
// exactly the same definitions of Net Sales / COGS / Gross / Operating / Net.
import { el, money, pct, rate, qty as fmtQty, toFa, group, parseNum, jalaliText, periodLabel } from './util.js';
import { state } from './app.js';

export const displayUnit = () => state.settings?.currency_display_unit || 'toman';

/** Applies a display-unit choice everywhere without another server round-trip. */
export function setDisplayUnit(unit) {
  state.settings = { ...(state.settings || {}), currency_display_unit: unit };
}

/* ------------------------------------------------------------- form bits -- */

/**
 * Amount input with an explicit unit switch (تومان ⇄ ریال).
 * 1 toman = 10 rial is applied here and re-checked on the server.
 */
export function MoneyField({ label, value = null, hint = '', required = false, name = 'amount', allowZero = true, onInput = null }) {
  let unit = 'toman';
  let touched = false;
  const input = el('input', {
    class: 'control',
    inputmode: 'decimal',
    autocomplete: 'off',
    name,
    placeholder: '۰',
    value: value === null || value === undefined ? '' : group(Math.round(value / (unit === 'rial' ? 10 : 1))),
  });
  const preview = el('div', { class: 'hint' });
  const tag = el('span', { class: 'unit-tag', text: 'تومان' });
  const btnToman = el('button', { type: 'button', text: 'تومان', 'aria-pressed': 'true' });
  const btnRial = el('button', { type: 'button', text: 'ریال', 'aria-pressed': 'false' });
  const switcher = el('div', { class: 'unit-switch' }, [btnToman, btnRial]);
  const node = el('div', { class: 'field' }, [
    el('label', { text: label + (required ? ' *' : '') }),
    el('div', { class: 'amount' }, [input, switcher, tag]),
    preview,
  ]);

  const convert = () => {
    const n = parseNum(input.value);
    if (Number.isNaN(n)) return;
    input.value = group(unit === 'rial' ? Math.round(n * 10) : Math.round(n / 10));
    sync();
  };
  const setUnit = (u) => {
    if (u === unit) return;
    unit = u;
    tag.textContent = u === 'rial' ? 'ریال' : 'تومان';
    btnToman.setAttribute('aria-pressed', String(u === 'toman'));
    btnRial.setAttribute('aria-pressed', String(u === 'rial'));
    if (touched) convert();
    else sync();
  };
  btnToman.addEventListener('click', () => setUnit('toman'));
  btnRial.addEventListener('click', () => setUnit('rial'));
  const sync = () => {
    const rial = field.rial();
    if (rial === null || Number.isNaN(rial)) preview.textContent = hint || '';
    else preview.textContent = `${money(rial, { unit: 'toman' })}  ·  ${money(rial, { unit: 'rial', withUnit: true })}`;
    if (onInput) onInput(rial);
  };
  input.addEventListener('input', () => {
    touched = true;
    sync();
  });
  input.addEventListener('blur', () => {
    const n = parseNum(input.value);
    if (!Number.isNaN(n)) input.value = group(Math.round(n));
    sync();
  });

  const field = {
    node,
    input,
    get unit() {
      return unit;
    },
    rial() {
      const raw = input.value.trim();
      if (raw === '') return null;
      const n = parseNum(raw);
      if (Number.isNaN(n)) return NaN;
      const rial = unit === 'rial' ? n : n * 10;
      return Math.round(rial);
    },
    set(rialValue) {
      if (rialValue === null || rialValue === undefined) input.value = '';
      else input.value = group(unit === 'rial' ? Math.round(rialValue) : Math.round(rialValue / 10));
      sync();
    },
    clear() {
      input.value = '';
      touched = false;
      sync();
    },
    focus() {
      input.focus();
    },
  };
  sync();
  return field;
}

export function QtyField({ label = 'تعداد / مقدار', value = 1, unitName = 'عدد', onInput = null }) {
  const input = el('input', { class: 'control', inputmode: 'decimal', value: value === null ? '' : toFa(String(value)).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))), placeholder: '۱' });
  const dec = (delta) => {
    const n = parseNum(input.value);
    const base = Number.isNaN(n) ? 0 : n;
    input.value = String(Math.max(0, Math.round((base + delta) * 1000) / 1000));
    input.dispatchEvent(new Event('input'));
  };
  const node = el('div', { class: 'field' }, [
    el('label', { text: `${label}${unitName ? ` (${unitName})` : ''}` }),
    el('div', { class: 'stepper' }, [
      el('button', { type: 'button', text: '−', 'aria-label': 'کاهش', onclick: () => dec(-1) }),
      input,
      el('button', { type: 'button', text: '+', 'aria-label': 'افزایش', onclick: () => dec(1) }),
    ]),
  ]);
  input.addEventListener('input', () => onInput?.(qtyThousandths()));
  function qtyThousandths() {
    const n = parseNum(input.value);
    if (Number.isNaN(n)) return NaN;
    return Math.round(n * 1000);
  }
  return { node, input, qty: qtyThousandths, set(v) { input.value = String(v / 1000); } };
}

export function SelectField({ label, options, value, onInput = null, hint = '' }) {
  const sel = el(
    'select',
    { class: 'control', name: label },
    options.map((o) => el('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, [o.label])),
  );
  sel.addEventListener('change', () => onInput?.(sel.value));
  return { node: el('div', { class: 'field' }, [el('label', { text: label }), sel, hint ? el('div', { class: 'hint', text: hint }) : null]), input: sel, value: () => sel.value };
}

export function Chips({ label, options, value, onChange, required = false }) {
  const host = el('div', { class: 'chips', role: 'group', 'aria-label': label });
  let current = value ?? options[0]?.value;
  const render = () => {
    host.replaceChildren();
    for (const o of options) {
      host.appendChild(
        el('button', {
          type: 'button',
          class: 'chip',
          'aria-pressed': String(o.value === current),
          text: o.label,
          onclick: () => {
            current = o.value;
            render();
            onChange?.(current);
          },
        }),
      );
    }
  };
  render();
  return {
    node: el('div', { class: 'field' }, [el('label', { text: label + (required ? ' *' : '') }), host]),
    get value() {
      return current;
    },
    set(v) {
      current = v;
      render();
    },
  };
}

export function TextField({ label, value = '', placeholder = '', multiline = false, required = false, maxLength = 500, hint = '', type = 'text', autocomplete = 'off' }) {
  const input = el(multiline ? 'textarea' : 'input', {
    class: 'control',
    placeholder,
    maxlength: maxLength,
    rows: multiline ? 2 : undefined,
    type: multiline ? undefined : type,
    autocomplete: multiline ? undefined : autocomplete,
    value: multiline ? undefined : value,
    name: label,
  });
  if (multiline) input.value = value;
  return { node: el('div', { class: 'field' }, [el('label', { text: label + (required ? ' *' : '') }), input, hint ? el('div', { class: 'hint', text: hint }) : null]), input, value: () => (input.value || '').trim() };
}

export function DateField({ label = 'تاریخ', value, onInput }) {
  const input = el('input', { class: 'control', type: 'date', value: value || state.clock.today, max: state.clock.today });
  const time = el('input', { class: 'control', type: 'time', value: (state.clock.time || '12:00').slice(0, 5) });
  const wrap = el('div', { class: 'grid cols-2' }, [
    el('div', { class: 'field' }, [el('label', { text: label }), input]),
    el('div', { class: 'field' }, [el('label', { text: 'ساعت' }), time]),
  ]);
  const emit = () => onInput?.({ date: input.value, time: time.value });
  input.addEventListener('change', emit);
  time.addEventListener('change', emit);
  return { node: wrap, date: () => input.value, time: () => time.value, set(date) { input.value = date; } };
}

/** Product/service picker with inline search and one-tap creation. */
export function ProductPicker({ label = 'کالا یا خدمت', products, value = null, onPick, onCreate }) {
  const search = el('input', { class: 'control', placeholder: 'جست‌وجوی نام کالا/خدمت…', autocomplete: 'off' });
  const list = el('div', { class: 'row-list', style: 'max-height:230px;overflow:auto' });
  let selected = value;
  const draw = () => {
    const q = (search.value || '').trim();
    const items = (products || []).filter((p) => (!q ? true : p.name.includes(q) || (p.sku || '').includes(q))).slice(0, 40);
    list.replaceChildren();
    if (!items.length) {
      list.appendChild(el('div', { class: 'empty' }, [el('p', { text: 'موردی یافت نشد. می‌توانید همین حالا بسازیدش.', style: 'margin:4px 0' })]));
    }
    for (const p of items) {
      const active = selected === p.id;
      list.appendChild(
        el('div', {
          class: 'row-item',
          role: 'button',
          tabindex: 0,
          style: active ? 'border-color:var(--brand);background:var(--brand-soft)' : '',
          onclick: () => {
            selected = p.id;
            onPick?.(p);
            draw();
          },
          onkeydown: (e) => {
            if (e.key === 'Enter') {
              selected = p.id;
              onPick?.(p);
              draw();
            }
          },
        }, [
          el('div', { class: 't' }, [
            el('b', { text: p.name }),
            el('span', { text: `${p.kind === 'service' ? 'خدمت' : 'کالا'} · موجودی ${fmtQty(p.stock_qty_x1000, { unit: p.unit })} · میانگین بها ${money(p.avg_unit_cost_rial || 0, { withUnit: false })}` }),
          ]),
          el('span', { class: 'badge', text: p.kind === 'service' ? 'خدمت' : `${fmtQty(p.stock_qty_x1000, { unit: p.unit })}` }),
        ]),
      );
    }
  };
  search.addEventListener('input', draw);
  draw();
  const newNode = el('div', { class: 'field' }, [
    el('label', { text: label }),
    search,
    list,
    onCreate
      ? el('button', {
          class: 'btn subtle sm',
          type: 'button',
          text: '＋ ساخت کالا/خدمت جدید',
          onclick: async () => {
            const name = (search.value || '').trim();
            if (!name) return search.focus();
            const created = await onCreate(name);
            if (created) {
              products.push(created);
              selected = created.id;
              onPick?.(created);
              draw();
            }
          },
        })
      : null,
  ]);
  return { node: newNode, get value() { return selected; }, set(v) { selected = v; draw(); } };
}

/* --------------------------------------------------------------- display -- */

export function Metric({ label, value, foot = null, cls = '', href = null, icon = null, unitNote = null }) {
  const node = el(href ? 'a' : 'div', { class: `metric ${cls}`, href: href || undefined }, [
    el('div', { class: 'label' }, [icon ? el('span', { text: icon }) : null, label]),
    el('div', { class: 'value' }, [value, unitNote ? el('span', { class: 'unit', text: unitNote }) : null]),
    foot ? el('div', { class: 'foot' }, [foot]) : null,
  ]);
  return node;
}

export function moneyValue(rial, { cls = '', label, foot = null, icon = null, href = null, compare = null } = {}) {
  const v = Number(rial) || 0;
  let footNode = foot;
  if (compare !== null && compare !== undefined) {
    const delta = v - Number(compare || 0);
    const cls2 = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '•';
    footNode = el('span', {}, [
      el('span', { class: `delta ${cls2}`, text: `${arrow} ${money(Math.abs(delta), { withUnit: true, sign: 'none' }).replace('−', '')}` }),
      foot ? el('span', { text: ` · ${foot}` }) : null,
    ]);
  }
  return Metric({
    label,
    value: money(v, { sign: 'auto' }),
    foot: footNode,
    cls: `${v < 0 ? 'neg' : v > 0 ? 'pos' : ''} ${cls}`.trim(),
    icon,
    href,
  });
}

export function tableOf(columns, rows, { empty = 'موردی برای نمایش وجود ندارد.', cls = '' } = {}) {
  const table = el('table', { class: cls });
  table.appendChild(el('thead', {}, [el('tr', {}, columns.map((c) => el('th', { class: c.num ? 'num' : '', text: c.label })))]));
  const body = el('tbody');
  if (!rows.length) body.appendChild(el('tr', {}, [el('td', { colspan: columns.length, style: 'text-align:center;color:var(--muted);padding:18px' }, [empty])]));
  for (const r of rows) {
    body.appendChild(el('tr', {}, columns.map((c) => el('td', { class: `${c.num ? 'num' : ''} ${c.align || ''}` }, [c.render ? c.render(r) : String(r[c.key] ?? '')]))));
  }
  table.appendChild(body);
  return el('div', { class: 'table-wrap' }, [table]);
}

/* ------------------------------------------------------ report statements -- */

export function ProfitStatement(report, { compact = false } = {}) {
  const s = report.sales;
  const p = report.profit;
  const rows = [
    { k: 'فروش ناخالص', v: s.gross_rial, hint: 'جمع مبلغ فاکتورها قبل از تخفیف و مرجوعی' },
    { k: 'تخفیف‌ها', v: -s.discounts_rial, hint: 'تخفیف خطی + تخفیف کل فاکتور' },
    { k: 'مرجوعی فروش', v: -s.returns_rial, hint: 'کاهش درآمد و بازگشت کالا به انبار' },
    { k: 'فروش خالص', v: s.net_rial, strong: true, rule: true },
    { k: 'بهای تمام‌شده کالای فروش‌رفته (میانگین موزون)', v: -s.cogs_rial, hint: 'فقط برای کالاهایی که فروش رفته‌اند' },
    { k: 'سود ناخالص', v: p.gross_rial, strong: true, rule: true, pct: p.margins_pct_x100.gross },
    { k: 'هزینه‌های عملیاتی', v: -(report.expenses.total_rial + report.expenses.inventory_adjustments_rial), hint: 'به‌همراه تعدیلات موجودی (اسقاط/کسری)' },
    { k: 'سود عملیاتی', v: p.operating_rial, strong: true, rule: true, pct: p.margins_pct_x100.operating },
    { k: 'بار مالی (بهرهٔ وام)', v: -report.expenses.loan_interest_rial, hint: 'اصل وام اینجا نمی‌آید؛ فقط بهره' },
    { k: 'سود (زیان) خالص', v: p.net_rial, strong: true, big: true, rule: true, pct: p.margins_pct_x100.net },
  ];
  const host = el('div', { class: 'grid', style: 'gap:2px' });
  for (const r of rows) {
    if (r.rule) host.appendChild(el('div', { style: 'border-top:1px solid var(--line);margin:4px 0' }));
    const neg = r.v < 0;
    host.appendChild(
      el('div', {
        style: `display:flex;align-items:baseline;gap:8px;justify-content:space-between;padding:${r.big ? '8px 0' : compact ? '3px 0' : '5px 0'}${r.strong ? ';font-weight:800' : ''}`,
      }, [
        el('div', { style: 'min-width:0' }, [
          el('span', { text: r.k }),
          r.hint && !compact ? el('div', { class: 'hint', style: 'font-weight:400', text: r.hint }) : null,
        ]),
        el('div', { style: 'text-align:end;white-space:nowrap' }, [
          el('span', { style: `font-variant-numeric:tabular-nums;font-size:${r.big ? '20px' : '14.5px'};color:${r.v < 0 ? 'var(--neg)' : r.strong && r.v > 0 ? 'var(--pos)' : 'inherit'}`, text: money(r.v, { withUnit: true }) }),
          r.pct !== undefined && r.pct !== null ? el('div', { class: 'hint', style: 'font-weight:400', text: `حاشیه ${pct(r.pct)}` }) : null,
        ]),
      ]),
    );
  }
  return host;
}

export function CashBlock(report) {
  const c = report.cash;
  return el('div', { class: 'grid cols-2' }, [
    moneyValue(c.inflow_rial, { label: 'ورودی نقد' }),
    moneyValue(-c.outflow_rial, { label: 'خروجی نقد' }),
    moneyValue(c.opening_rial, { label: 'موجودی اول دوره' }),
    moneyValue(c.closing_rial, { label: 'موجودی پایان دوره', foot: `تغییر دوره: ${money(c.net_rial, { withUnit: true })}` }),
    ...(c.byAccount.length
      ? [
          el('div', { style: 'grid-column:1/-1' }, [
            tableOf(
              [{ label: 'حساب' }, { label: 'اول دوره', num: true, render: (r) => money(r.opening_rial, { withUnit: true }) }, { label: 'پایان دوره', num: true, render: (r) => money(r.closing_rial, { withUnit: true }) }],
              c.byAccount,
            ),
          ]),
        ]
      : []),
    c.unassigned_rial
      ? el('div', { style: 'grid-column:1/-1' }, [el('div', { class: 'notice warn', text: `بخشی از وجوه به حسابی تخصیص نیافته است: ${money(c.unassigned_rial, { unit: displayUnit() })}` })])
      : null,
  ]);
}

export function BalancesBlock(report) {
  const r = report.receivables;
  const p = report.payables;
  return el('div', { class: 'grid cols-2' }, [
    moneyValue(r.closing_rial, { label: 'حساب‌های پرداختنی مشتریان (طلب)', foot: `وصول‌شده در دوره: ${money(r.collected_rial, { withUnit: true })}` }),
    moneyValue(p.closing_rial, { label: 'حساب‌های دریافتنی تأمین‌کنندگان (بدهی)', foot: `پرداخت‌شده در دوره: ${money(p.paid_rial, { withUnit: true })}` }),
    r.carried_opening_rial ? el('div', { class: 'notice info', style: 'grid-column:1/-1' }, [`بخشی از ماندها بازگشایی است: طلب ${money(r.carried_opening_rial, { withUnit: true })} — بدهی ${money(p.carried_opening_rial, { withUnit: true })}`].map((t) => el('span', { text: t }))) : null,
    ...[
      tableOf([{ label: 'مشتری (طلبکار)' }, { label: 'مانده', num: true, render: (x) => money(x.outstanding_rial, { withUnit: true }) }, { label: 'فاکتور', num: true, render: (x) => toFa(x.invoices) }], r.byParty, { empty: 'هیچ مشتری بدهکار نیست.' }),
      tableOf([{ label: 'تأمین‌کننده (طلبکار)' }, { label: 'مانده', num: true, render: (x) => money(x.outstanding_rial, { withUnit: true }) }, { label: 'فاکتور', num: true, render: (x) => toFa(x.invoices) }], p.byParty, { empty: 'هیچ بدهی به تأمین‌کننده باز نیست.' }),
    ],
  ]);
}

export function InventoryBlock(report) {
  const inv = report.inventory;
  const mv = inv.movement;
  return el('div', { class: 'grid' }, [
    el('div', { class: 'grid cols-2' }, [
      moneyValue(mv.opening_rial, { label: 'ارزش موجودی اول دوره' }),
      moneyValue(mv.closing_rial, { label: 'ارزش موجودی پایان دوره' }),
      moneyValue(mv.purchases_rial, { label: 'خرید دوره (بهای تمام‌شده + هزینه جانبی)' }),
      moneyValue(-mv.cogs_rial, { label: 'بهای تمام‌شدهٔ فروش‌رفته' }),
    ]),
    el('div', { class: 'notice' + (mv.residual_rial === 0 ? ' info' : ' bad') }, [
      el('b', { text: mv.residual_ial === 0 || mv.residual_rial === 0 ? 'کنترل جمع‌بندی موجودی صحیح است.' : 'اختلاف در جمع‌بندی موجودی!' }),
      el('span', { text: ` اول + خرید − تعدیلات − بهای تمام‌شده − پایان = ${money(mv.residual_rial, { withUnit: true })}` }),
    ]),
    tableOf(
      [
        { label: 'کالا/خدمت', render: (x) => el('b', { text: x.name }) },
        { label: 'اول', num: true, render: (x) => fmtQty(x.opening_qty_x1000) },
        { label: 'فروش', num: true, render: (x) => fmtQty(x.sold_qty_x1000) },
        { label: 'پایان', num: true, render: (x) => el('span', { class: x.closing_qty_x1000 < 0 ? 'neg' : '', text: fmtQty(x.closing_qty_x1000) }) },
        { label: 'ارزش پایان', num: true, render: (x) => money(x.closing_value_rial, { withUnit: true }) },
        { label: 'میانگین بها', num: true, render: (x) => money(x.avg_unit_cost_rial, { withUnit: true }) },
      ],
      inv.items,
      { empty: 'موجودی‌ای ثبت نشده است.', cls: 'table-compact' },
    ),
    inv.negative_items.length
      ? el('div', { class: 'notice bad' }, [
          el('b', { text: 'موجودی منفی: ' }),
          inv.negative_items.map((i) => `${i.name} (${fmtQty(i.qty_x1000)})`).join('، ') + ' — این مورد مانع صدور گزارش نهایی می‌شود.',
        ])
      : null,
  ]);
}

export function GapsBlock(report) {
  const g = report.dataGaps;
  if (g.canFinalize && !g.warnings.length) return el('div', { class: 'notice' }, [el('b', { text: 'داده‌ها کامل است. ' }), 'می‌توان گزارش را به‌صورت نهایی بست.']);
  const node = el('div', { class: 'grid', style: 'gap:8px' });
  for (const b of g.blocking) node.appendChild(el('div', { class: 'notice bad' }, [el('b', { text: 'مانع گزارش نهایی: ' }), b.message]));
  for (const w of g.warnings) node.appendChild(el('div', { class: 'notice warn' }, [el('b', { text: 'هشدار: ' }), w.message]));
  return node;
}

export function FxBlock(fx) {
  if (!fx || !fx.latest) {
    return el('div', { class: 'notice info' }, ['هنوز هیچ نرخ دلاری دستی ثبت نشده است. برای افزودن به بخش «مدیریت دلار و تورم» بروید.']);
  }
  const p = fx.period || {};
  const arrow = fx.change_abs_x100 > 0 ? '▲' : fx.change_abs_x100 < 0 ? '▼' : '•';
  return el('div', { class: 'grid cols-2' }, [
    Metric({ label: 'آخرین نرخ دلار (دستی)', value: rate(fx.latest.rate_toman_x100), foot: `در تاریخ ${jalaliText(fx.latest.effective_date, { style: 'short' })}`, icon: '💵' }),
    Metric({
      label: 'تغییر نسبت به نرخ قبلی',
      value: `${arrow} ${pct(fx.change_pct_x100)}`,
      foot: `${money(Math.round(Math.abs((fx.change_abs_x100 || 0) / 100)), { unit: 'toman', withUnit: true }).replace('−', '')} تفاوت مطلق`,
      cls: fx.change_abs_x100 > 0 ? 'neg' : fx.change_abs_x100 < 0 ? 'pos' : '',
    }),
    Metric({ label: `نرخ ابتدای دوره`, value: rate(p.start_rate_x100), foot: p.start ? `سابقه: ${jalaliText(p.start.effective_date, { style: 'short' })}${p.start.exact ? '' : ' (نزدیک‌ترین ثبت قبلی)'}` : 'ثبتی برای این تاریخ وجود ندارد' }),
    Metric({
      label: 'نرخ انتهای دوره',
      value: rate(p.end_rate_x100),
      foot: p.end
        ? `سابقه: ${jalaliText(p.end.effective_date, { style: 'short' })}${p.end_stale_days > 3 ? ` · ${toFa(p.end_stale_days)} روز قدیمی` : ''}`
        : 'ثبتی برای این تاریخ وجود ندارد',
    }),
    p.avg_rate_x100
      ? el('div', { class: 'notice info', style: 'grid-column:1/-1' }, [
          el('b', { text: `میانگین ${toFa(p.records_in_period)} ثبت این دوره: ` }),
          `${rate(p.avg_rate_x100)} — `,
          el('span', { class: 'estimate-tag', text: 'میانگین نرخ‌های ثبت‌شدهٔ خودتان، نه میانگین رسمی بازار' }),
        ])
      : null,
    p.change_pct_x100 !== null && p.change_pct_x100 !== undefined
      ? Metric({ label: 'تغییر نرخ دلار در دوره', value: pct(p.change_pct_x100), cls: p.change_pct_x100 > 0 ? 'neg' : 'pos' })
      : null,
  ]);
}

export function RealProfitBlock(data) {
  const r = data.real || {};
  return el('div', { class: 'grid' }, [
    el('div', { class: 'notice warn' }, [
      el('b', { text: 'این بخش برآورد است. ' }),
      'ضریب تورم از فرض واردشدهٔ خودتان ساخته می‌شود و نرخ رسمی تورم کشور نیست. درصد تغییر نرخ دلار هم شاخص جداگانه‌ای است و با تورم اشتباه گرفته نشود.',
    ]),
    el('div', { class: 'grid cols-2' }, [
      moneyValue(data.nominal.current_net_rial, { label: 'سود اسمی این ماه', compare: data.nominal.previous_net_rial }),
      r.available
        ? moneyValue(r.current_net_rial, { label: `سود واقعی (بر حسب پول ${periodLabel(r.base_period)})`, foot: data.nominal.current_net_rial ? `قدرت خرید: ${pct(r.purchasing_power_change_pct_x100)}` : null, cls: 'hero' })
        : el('div', { class: 'notice bad' }, [`قابل محاسبه نیست — فرض تورم برای ${r.missing_periods.map(periodLabel).join('، ')} ثبت نشده است.`]),
      moneyValue(r.cash_closing_rial, { label: 'نقدینگی پایانی (اسمی)', foot: r.cash_real_rial !== null && r.cash_real_rial !== undefined ? `معادل ${money(r.cash_real_rial, { withUnit: true })} پول پایه` : null }),
      moneyValue(r.inventory_closing_rial, { label: 'موجودی پایان دوره (اسمی)', foot: r.inventory_real_rial ? `معادل ${money(r.inventory_real_rial, { withUnit: true })} پول پایه` : null }),
    ]),
    data.fx && data.fx.period && data.fx.period.change_pct_x100 !== null
      ? el('div', { class: 'notice info' }, [
          el('b', { text: 'مقایسهٔ دو شاخص: ' }),
          `تغییر نرخ دلار در دوره ${pct(data.fx.period.change_pct_x100)} — فرض تورم ماهانهٔ شما ${
            data.inflation?.items?.[0] ? pct(data.inflation.items[0].rate_pct_x100) : 'ثبت‌نشده'
          }. این دو عدد دو چیز متفاوت را نشان می‌دهند.`,
        ])
      : null,
  ]);
}

export function ReplacementBlock(ra) {
  if (!ra) return el('div', { class: 'notice info' }, ['برای این دوره داده‌ای برای تحلیل جایگزینی موجودی موجود نیست.']);
  return el('div', { class: 'grid' }, [
    el('div', { class: 'notice warn' }, [
      el('span', { class: 'estimate-tag', text: 'برآورد مدیریتی' }),
      ' سود بر مبنای هزینهٔ جایگزینی، جایگزین سود حسابداری رسمی نیست؛ نشان می‌دهد با قیمت امروزِ خرید مجدد، سود شما چقدر واقعی می‌ماند.',
    ]),
    ra.available
      ? el('div', { class: 'grid cols-2' }, [
          moneyValue(ra.profit_historical_rial, { label: 'سود با بهای تمام‌شدهٔ تاریخی' }),
          moneyValue(ra.profit_replacement_rial, { label: 'سود با هزینهٔ جایگزینی امروز' }),
          moneyValue(ra.difference_rial, { label: 'اختلاف (سود نگهداری‌شده در موجودی)', foot: 'مثبت یعنی بخشی از سود اسمی فقط جانشین گرانی کالا شده است' }),
          Metric({ label: 'پوشش کالاها با نرخ جایگزینی', value: ra.coverage_pct_x100 === null ? '—' : pct(ra.coverage_pct_x100), foot: 'هرچه بالاتر، برآورد قابل‌اتکاتر' }),
        ])
      : el('div', { class: 'notice bad' }, ['برای هیچ‌کدام از کالاهای فروش‌رفتهٔ این دوره «هزینهٔ جایگزینی» وارد نشده است.']),
    ra.missing_products?.length ? el('div', { class: 'notice warn' }, [`بدون برآورد جایگزینی: ${ra.missing_products.join('، ')}`]) : null,
    tableOf(
      [
        { label: 'کالا', render: (x) => el('b', { text: x.name }) },
        { label: 'فروش رفته', num: true, render: (x) => fmtQty(x.sold_qty_x1000 || 0) },
        { label: 'بای تاریخی', num: true, render: (x) => money(x.historical_cogs_rial || 0, { withUnit: false }) },
        { label: 'نرخ جایگزینی واحد', num: true, render: (x) => (x.replacement_unit_cost_rial ? money(x.replacement_unit_cost_rial, { withUnit: true }) : '—') },
        { label: 'بهای جایگزینی', num: true, render: (x) => (x.replacement_cogs_rial !== undefined ? money(x.replacement_cogs_rial, { withUnit: true }) : '—') },
        { label: 'اختلاف', num: true, render: (x) => (x.difference_rial !== undefined ? money(x.difference_rial, { withUnit: true }) : '—') },
      ],
      (ra.items || []).filter((i) => i.sold_qty_x1000 !== undefined),
      { empty: 'در این دوره کالایی فروش نرفته است.', cls: 'table-compact' },
    ),
  ]);
}

export function ReportBlocks(report, { showInventory = true, showReal = true, showReplacement = true } = {}) {
  const host = el('div', { class: 'grid', style: 'gap:12px' });
  host.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'صورت سود و زیان' }), el('span', { class: 'spacer' }), el('span', { class: 'badge', text: 'بهای تمام‌شده: میانگین موزون' })]),
      el('div', { class: 'card-b' }, [ProfitStatement(report)]),
    ]),
  );
  host.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'هزینه‌ها و نقدینگی' })]),
      el('div', { class: 'card-b grid' }, [
        el('h4', { style: 'margin:0;font-size:13px;color:var(--muted)', text: 'تفکیک هزینه‌های عملیاتی' }),
        breakdownRows(report),
        el('h4', { style: 'margin:8px 0 0;font-size:13px;color:var(--muted)', text: 'جریان نقد' }),
        CashBlock(report),
      ]),
    ]),
  );
  host.appendChild(el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h2', { text: 'طلب و بدهی' })]), el('div', { class: 'card-b' }, [BalancesBlock(report)])]));
  if (showInventory) host.appendChild(el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h2', { text: 'موجودی کالا' })]), el('div', { class: 'card-b' }, [InventoryBlock(report)])]));
  host.appendChild(el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h2', { text: 'سرمایه، وام و واحد پول' })]), el('div', { class: 'card-b grid' }, [CapitalBlock(report), FxBlock(report.fx)])]));
  if (showReal && report.real_analysis) host.appendChild(el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h2', { text: 'سود واقعی و اثر تورم' }), el('span', { class: 'estimate-tag', text: 'برآورد' })]), el('div', { class: 'card-b' }, [RealProfitBlock({ real: report.real_analysis, nominal: { current_net_rial: report.profit.net_rial, previous_net_rial: null }, inflation: { items: report.inflation_assumptions || [] }, fx: report.fx })])]));
  if (showReplacement && report.replacement_analysis) host.appendChild(el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h2', { text: 'تحلیل هزینهٔ جایگزینی موجودی' })]), el('div', { class: 'card-b' }, [ReplacementBlock(report.replacement_analysis)])]));
  host.appendChild(el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h2', { text: 'کنترل داده‌ها' })]), el('div', { class: 'card-b' }, [GapsBlock(report)])]));
  return host;
}

function CapitalBlock(report) {
  return el('div', { class: 'grid cols-2' }, [
    moneyValue(report.capital.deposits_rial, { label: 'وارسه سرمایه (درآمد نیست)' }),
    moneyValue(-report.capital.withdrawals_rial, { label: 'برداشت شخصی (هزینه نیست)' }),
    moneyValue(report.loans.borrowed_rial, { label: 'اصل دریافتی وام (هزینه/درآمد نیست)' }),
    moneyValue(-report.loans.repaid_rial, { label: 'اقساط بازپرداخت اصل وام' }),
    moneyValue(-report.loans.interest_rial, { label: 'بهره و کارمزد مالی (کاهش سود خالص)' }),
    moneyValue(report.purchases.total_rial, { label: 'خرید دوره (افزایش موجودی)', foot: 'هزینه نمی‌شود تا وقتی فروخته شود' }),
  ]);
}

function breakdownRows(report) {
  const rows = report.expenses.byCategory.map((e) => ({
    label: e.label,
    value: e.amount_rial,
    pct: report.sales.net_rial ? pct(Math.round((e.amount_rial / report.sales.net_rial) * 10000)) : null,
  }));
  if (!rows.length) return el('div', { class: 'notice info' }, ['در این دوره هزینه‌ای ثبت نشده است.']);
  const host = el('div', { class: 'grid' });
  for (const r of rows) {
    host.appendChild(
      el('div', { style: 'display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed var(--line);padding:6px 0' }, [
        el('span', { text: r.label }),
        el('b', { style: 'font-variant-numeric:tabular-nums', text: money(r.value, { withUnit: true }) }),
        el('span', { class: 'hint', text: r.pct || '' }),
      ]),
    );
  }
  host.appendChild(
    report.expenses.inventory_adjustments_rial
      ? el('div', { style: 'display:flex;justify-content:space-between;gap:8px;padding:6px 0' }, [
          el('span', { text: 'تعدیلات موجودی (اسقاط/کسری)' }),
          el('b', { text: money(report.expenses.inventory_adjustments_rial, { withUnit: true }) }),
          el('span', {}),
        ])
      : null,
  );
  return host;
}

export { money, pct, rate, jalaliText, periodLabel, group, toFa };
