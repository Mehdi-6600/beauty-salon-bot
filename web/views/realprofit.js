// سود واقعی و اثر تورم — nominal vs inflation-adjusted profit, purchasing power
// of cash/inventory, and the inventory-replacement estimate.
import { el, clear, money, pct, toFa, periodLabel } from '../util.js';
import { get } from '../api.js';
import { tableOf, FxBlock, ReplacementBlock, displayUnit } from '../components.js';
import { barChart } from '../charts.js';
import { state as appState } from '../app.js';

export async function render(host, { params, refresh }) {
  clear(host);
  const unit = displayUnit();
  const period = params.get('period') || appState.clock.today_period;
  const data = await get(`/api/real-profit?period=${period}`);
  const root = el('div', { class: 'grid', style: 'gap:12px' });

  const options = [];
  let p = appState.clock.today_period;
  for (let i = 0; i < 24; i += 1) {
    options.push(p);
    const [y, m] = p.split('-').map(Number);
    let ny = y;
    let nm = m - 1;
    if (nm < 1) {
      nm = 12;
      ny -= 1;
    }
    p = `${ny}-${String(nm).padStart(2, '0')}`;
  }
  const sel = el('select', { class: 'control' }, options.map((o) => el('option', { value: o, selected: o === period, text: periodLabel(o) })));
  sel.addEventListener('change', () => {
    location.hash = `#/real-profit?period=${sel.value}`;
  });

  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'سود واقعی و اثر تورم' }), el('span', { class: 'spacer' }), sel]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'notice warn' }, [el('b', { text: 'این اعداد برآورد است. ' }), data.disclaimer]),
      ]),
    ]),
  );

  /* A. nominal vs B. real */
  const n = data.nominal;
  const r = data.real;
  root.appendChild(
    el('div', { class: 'grid cols-2' }, [
      block('A) سود اسمی — بر حسب پولِ خود دوره', [
        row('سود خالص این ماه', n.current_net_rial, true),
        row('سود خالص ماه قبل', n.previous_net_rial),
        row(
          'تغییر اسمی',
          null,
          false,
          `<span class="${n.change_rial > 0 ? 'pos' : 'neg'}">${money(n.change_rial, { unit, withUnit: true })} (${pct(n.change_pct_x100)})</span>`,
        ),
        row('فروش خالص این ماه', n.current_sales_rial),
        row('فروش خالص ماه قبل', n.previous_sales_rial),
      ]),
      block('B) سود واقعی — بر حسب پولِ دورهٔ پایه', [
        r.available
          ? row(`سود واقعی (پول ${periodLabel(r.base_period)})`, r.current_net_rial, true)
          : el('div', { class: 'notice bad' }, [`قابل محاسبه نیست: فرض تورم برای ${r.missing_periods.map(periodLabel).join('، ')} ثبت نشده است. برای افزودن به «مدیریت دلار و تورم» بروید.`]),
        r.available ? row('تغییر قدرت خرید سود', null, false, `<b class="${r.purchasing_power_change_pct_x100 < 0 ? 'neg' : 'pos'}">${pct(r.purchasing_power_change_pct_x100)}</b>`) : null,
        row('ضریب تورم انباشته از دورهٔ پایه', null, false, r.available ? `${toFa((r.cumulative_factor_x1e6 / 1_000_000).toFixed(3))}×` : '—'),
        row('نقدینگی پایانی (اسمی)', r.cash_closing_rial),
        r.cash_real_rial !== null && r.cash_real_rial !== undefined ? row('نقدینگی پایانی (واقعی)', r.cash_real_rial) : null,
        row('موجودی پایان دوره (اسمی)', r.inventory_closing_rial),
        r.inventory_real_rial !== null && r.inventory_real_rial !== undefined ? row('موجودی پایان دوره (واقعی)', r.inventory_real_rial) : null,
      ]),
    ]),
  );

  if (!r.available) {
    root.appendChild(
      el('div', { class: 'notice' }, [
        'تا زمانی که فرض تورم ماه‌های لازم ثبت نشده، هیچ عددی ساخته نمی‌شود. پس از ثبت، مقایسهٔ اسمی/واقعی خودبه‌خود فعال می‌شود. ',
        el('a', { href: '#/fx', text: 'رفتن به ثبت تورم ←' }),
      ]),
    );
  }

  /* trend chart: nominal bars + real line */
  const trend = data.monthly_trend || [];
  if (trend.some((x) => x.nominal_net_rial !== 0)) {
    root.appendChild(
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'روند سود اسمی و نرخ دلار' }), el('span', { class: 'spacer' }), el('span', { class: 'hint', style: 'margin:0', text: 'میله: سود اسمی · خط: نرخ دلار' })]),
        el('div', { class: 'card-b' }, [
          barChart(trend.map((x) => ({ label: x.label, shortLabel: x.label.split(' ')[0], value: x.nominal_net_rial, secondary: x.fx_end_rate_x100 })), {
            height: 180,
            lineLabel: 'نرخ دلار',
            format: (v) => (Math.abs(v) > 1_000_000 ? toFa(Math.round(v / 1_000_000)) + 'میلیون' : toFa(Math.round(v / 1000)) + 'هزار'),
          }),
          tableOf(
            [
              { label: 'ماه' },
              { label: 'سود اسمی', num: true, render: (x) => money(x.nominal_net_rial, { unit, withUnit: true }) },
              { label: 'فروش خالص', num: true, render: (x) => money(x.net_sales_rial, { unit, withUnit: true }) },
              { label: 'نرخ دلار پایان', num: true, render: (x) => (x.fx_end_rate_x100 ? toFa(group(x.fx_end_rate_x100 / 100)) : '—') },
              { label: 'فرض تورم ماه', num: true, render: (x) => (x.inflation_pct_x100 !== null ? pct(x.inflation_pct_x100) : 'ثبت‌نشده') },
            ],
            [...trend].reverse().map((x) => ({ ...x, 0: x.label })),
            { cls: 'table-compact' },
          ),
        ]),
      ]),
    );
  }

  /* replacement cost perspective */
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'جایگزینی موجودی و سود نگهداری‌شده' }), el('span', { class: 'spacer' }), el('span', { class: 'estimate-tag', text: 'برآورد مدیریتی' })]),
      el('div', { class: 'card-b' }, [ReplacementBlock(data.replacement)]),
    ]),
  );

  /* inflation vs fx */
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'نرخ دلار در همین دوره (شاخص جدا)' })]),
      el('div', { class: 'card-b' }, [FxBlock(data.fx)]),
    ]),
  );

  host.appendChild(root);
}

function block(title, children) {
  return el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h3', { text: title })]), el('div', { class: 'card-b' }, children)]);
}

function group2(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
}
const group = (n) => group2(Math.abs(n));

function row(label, rial, strong = false, html = null) {
  return el('div', {
    style: `display:flex;justify-content:space-between;gap:10px;align-items:baseline;padding:5px 0${strong ? ';font-weight:800' : ''};border-bottom:1px dashed var(--line)`,
  }, [
    el('span', { text: label }),
    html ? el('span', { html, style: 'font-variant-numeric:tabular-nums' }) : el('span', { style: `font-variant-numeric:tabular-nums;color:${rial < 0 ? 'var(--neg)' : 'inherit'}`, text: money(rial, { unit: displayUnit(), withUnit: true }) }),
  ]);
}
