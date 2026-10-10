// سود و زیان — live statement for the selected period with month-to-month
// comparison, printable layout and CSV output.
import { el, clear, money, pct, toFa, periodLabel, jalaliText } from '../util.js';
import { ReportBlocks, tableOf, displayUnit } from '../components.js';
import { get } from '../api.js';
import { state as appState, rangeParams } from '../app.js';
import { barChart } from '../charts.js';

export async function render(host, { params, refresh }) {
  clear(host);
  const unit = displayUnit();
  const root = el('div', { class: 'grid', style: 'gap:12px' });
  host.appendChild(root);

  const range = appState.range || { mode: 'month' };
  let data;
  let title;
  let subtitle;
  if (range.mode === 'year') {
    const year = appState.clock.this_year;
    data = await get(`/api/reports/yearly/${year}`);
    title = `سود و زیان ${data.report.period_label || `سال ${toFa(year)}`}`;
    subtitle = 'جمع دوازده ماه جلالی — هر ماه جداگانه محاسبه و سپس جمع شده است';
  } else if (range.mode === 'custom' && range.from && range.to) {
    data = { report: await get(`/api/reports/range?from=${range.from}&to=${range.to}`) };
    title = 'سود و زیان بازهٔ دلخواه';
    subtitle = `${jalaliText(range.from, { style: 'short' })} تا ${jalaliText(range.to, { style: 'short' })} — گزارش قابل بستن فقط برای ماه/سال کامل جلالی است`;
  } else {
    const period = range.mode === 'prev' ? shift(appState.clock.today_period, -1) : params.get('period') || appState.clock.today_period;
    data = await get(`/api/reports/monthly/${period}`);
    title = `سود و زیان ${periodLabel(period)}`;
    subtitle = 'ارقام زنده از دفتر کل — با هر اصلاح در داده‌ها بازمحاسبه می‌شود';
  }
  const report = data.report || data;

  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [
        el('h2', { text: title }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn sm ghost no-print',
          text: '🖨️ چاپ گزارش',
          onclick: () => window.print(),
        }),
        el('a', { class: 'btn sm ghost no-print', href: `/api/export.csv?table=monthly&${rangeParams()}`, download: true, text: 'CSV' }),
      ]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'print-head' }, [el('b', { text: `هایپر سینا — ${title}` }), el('div', { class: 'hint', text: subtitle })]),
        el('div', { class: 'notice info' }, [subtitle]),
        el('div', { class: 'grid cols-4', style: 'margin-top:10px' }, [
          m('فروش خالص', report.sales.net_rial),
          m('سود ناخالص', report.profit.gross_rial, `حاشیه ${pct(report.profit.margins_pct_x100.gross)}`),
          m('سود عملیاتی', report.profit.operating_rial, `حاشیه ${pct(report.profit.margins_pct_x100.operating)}`),
          m('سود (زیان) خالص', report.profit.net_rial, `حاشیه ${pct(report.profit.margins_pct_x100.net)}`),
        ]),
      ]),
    ]),
  );

  root.appendChild(ReportBlocks(report, { showReal: !!report.real_analysis, showReplacement: !!report.replacement_analysis }));

  if (data.previous_year) {
    const py = data.previous_year;
    root.appendChild(
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: `مقایسهٔ سال ${toFa(data.year)} با سال ${toFa(Number(data.year) - 1)}` })]),
        el('div', { class: 'card-b' }, [
          tableOf(
            [
              { label: 'شاخص', render: (x) => el('b', { text: x.k }) },
              { label: `سال ${toFa(data.year)}`, num: true, render: (x) => money(x.a, { unit, withUnit: true }) },
              { label: `سال ${toFa(Number(data.year) - 1)}`, num: true, render: (x) => money(x.b, { unit, withUnit: true }) },
              {
                label: 'تغییر',
                num: true,
                render: (x) => {
                  if (!x.b) return el('span', { text: '—' });
                  const d = x.a - x.b;
                  return el('span', { class: d > 0 ? 'pos' : d < 0 ? 'neg' : '', text: `${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${money(Math.abs(d), { unit, withUnit: true })}` });
                },
              },
            ],
            [
              { k: 'فروش خالص', a: report.sales.net_rial, b: py.net_sales_rial },
              { k: 'سود خالص', a: report.profit.net_rial, b: py.net_profit_rial },
            ],
          ),
          el('div', { class: 'notice info' }, ['برای دیدن اثر تورم روی همین مقایسه، بخش «سود واقعی و اثر تورم» را ببینید — تورم و نرخ دلار آنجا جدا نگه داشته می‌شوند.']),
        ]),
      ]),
    );
  }
  if (data.months) {
    const active = data.months.filter((x) => x.net_sales_rial !== 0 || x.expenses_rial !== 0);
    root.appendChild(
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'روند ماه‌های سال' })]),
        el('div', { class: 'card-b' }, [
          active.length
            ? barChart(active.map((x) => ({ label: x.label, shortLabel: String(x.period).slice(5), value: x.net_profit_rial, secondary: x.fx_end_rate_x100 })), {
                height: 190,
                lineLabel: 'نرخ دلار',
                format: (v) => (Math.abs(v) > 1_000_000 ? toFa(Math.round(v / 1_000_000)) + 'م' : toFa(Math.round(v / 1000)) + 'ه'),
              })
            : el('div', { class: 'notice info', text: 'در این سال فروشی ثبت نشده است.' }),
          tableOf(
            [
              { label: 'ماه', render: (x) => el('b', { text: x.label || periodLabel(x.period) }) },
              { label: 'فروش خالص', num: true, render: (x) => money(x.net_sales_rial, { unit, withUnit: true }) },
              { label: 'سود ناخالص', num: true, render: (x) => money(x.gross_profit_rial, { unit, withUnit: true }) },
              { label: 'هزینه', num: true, render: (x) => money(x.expenses_rial, { unit, withUnit: true }) },
              { label: 'سود خالص', num: true, render: (x) => el('span', { class: x.net_profit_rial < 0 ? 'neg' : 'pos', text: money(x.net_profit_rial, { unit, withUnit: true }) }) },
              { label: 'حاشیه', num: true, render: (x) => pct(x.net_margin_pct_x100) },
              { label: 'نرخ دلار پایان', num: true, render: (x) => (x.fx_end_rate_x100 ? toFa(Math.round(x.fx_end_rate_x100 / 100)) : '—') },
            ],
            data.months,
            { cls: 'table-compact' },
          ),
        ]),
      ]),
    );
  }
}

function shift(period, delta) {
  const [y, m] = period.split('-').map(Number);
  let ny = y;
  let nm = m + delta;
  while (nm < 1) { nm += 12; ny -= 1; }
  while (nm > 12) { nm -= 12; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

function m(label, rial, foot = null) {
  const unit = displayUnit();
  return el('div', { class: `metric ${rial < 0 ? 'neg' : rial > 0 ? 'pos' : ''}` }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'value', text: money(rial, { unit, withUnit: true }) }),
    foot ? el('div', { class: 'foot', text: foot }) : null,
  ]);
}
