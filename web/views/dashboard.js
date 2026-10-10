// داشبورد — the first screen a shop owner needs: today, this month, this year,
// cash, receivables/payables, inventory, the manual USD rate, trend & quick adds.
import { el, clear, money, pct, rate, jalaliText, toFa } from '../util.js';
import { Metric, moneyValue, displayUnit, tableOf } from '../components.js';
import { get } from '../api.js';
import { barChart } from '../charts.js';

export async function render(host, { state, refresh }) {
  clear(host);
  const data = await get('/api/dashboard');
  const unit = displayUnit();
  const m = data.month_report;
  const t = data.today_report;
  const y = data.year_report;

  const root = el('div', { class: 'grid', style: 'gap:12px' });

  /* header strip */
  root.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-b', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
        el('div', { style: 'min-width:0;flex:1' }, [
          el('div', { style: 'font-size:12.5px;color:var(--muted)', text: data.business_name }),
          el('b', { style: 'font-size:15px', text: `${data.today_label}` }),
        ]),
        el('span', { class: `badge ${m.profit.net_rial < 0 ? 'bad' : 'ok'}`, text: m.profit.net_rial < 0 ? 'زیان این ماه' : 'سود این ماه' }),
        el('a', { class: 'btn sm ghost', href: '#/pnl', text: 'گزارش کامل سود و زیان' }),
      ]),
    ]),
  );

  /* alerts */
  if (data.alerts?.length) {
    const box = el('div', { class: 'grid', style: 'gap:8px' });
    for (const a of data.alerts) box.appendChild(el('div', { class: `notice ${a.level === 'danger' ? 'bad' : a.level === 'warn' ? 'warn' : 'info'}` }, [a.text]));
    root.appendChild(box);
  }

  /* hero numbers — profit first, never hidden */
  root.appendChild(
    el('div', { class: 'grid cols-2' }, [
      moneyValue(m.profit.net_rial, {
        label: `سود (زیان) خالص ${data.period_label}`,
        cls: 'hero',
        foot: `حاشیه سود ${pct(m.profit.margins_pct_x100.net)} · فروش خالص ${money(m.sales.net_rial, { withUnit: true, unit })}`,
        compare: data.previous_month_report?.net_rial ?? null,
      }),
      moneyValue(y.net_rial, {
        label: `${y.label} — سود خالص سال`,
        cls: 'hero',
        foot: `فروش ${money(y.net_sales_rial, { withUnit: true, unit })} · هزینه ${money(y.expenses_rial, { withUnit: true, unit })}`,
      }),
    ]),
  );

  root.appendChild(
    el('div', { class: 'grid cols-4' }, [
      moneyValue(t.sales.net_rial, { label: 'فروش امروز', foot: `${toFa(t.sales.invoices)} فاکتور` }),
      moneyValue(-(t.expenses.total_rial ?? 0), { label: 'هزینه‌های امروز' }),
      moneyValue(m.cash.closing_rial, { label: 'نقد در صندوق و بانک', foot: m.cash.accounts_configured ? `تغییر ماه: ${money(m.cash.net_rial, { unit, withUnit: true })}` : 'حسابی تعریف نشده', href: '#/accounts' }),
      Metric({
        label: 'نرخ دلار (ورودی دستی)',
        value: data.fx?.latest ? rate(data.fx.latest.rate_toman_x100, { unit: 'تومان' }) : 'ثبت نشده',
        foot: data.fx?.latest
          ? `${data.fx.change_pct_x100 !== null ? pct(data.fx.change_pct_x100) : '—'} نسبت به ثبت قبلی · ${jalaliText(data.fx.latest.effective_date, { style: 'short' })}`
          : 'برای ثبت به بخش دلار و تورم بروید',
        href: '#/fx',
        icon: '💵',
      }),
    ]),
  );

  root.appendChild(
    el('div', { class: 'grid cols-4' }, [
      moneyValue(m.receivables.closing_rial, { label: 'طلب از مشتریان', href: '#/accounts', foot: `${toFa(m.receivables.byParty.length)} مشتری` }),
      moneyValue(m.payables.closing_rial, { label: 'بدهی به تأمین‌کنندگان', href: '#/accounts', foot: `${toFa(m.payables.byParty.length)} تأمین‌کننده` }),
      moneyValue(m.inventory.closing_value_rial, { label: 'ارزش موجودی کالا', href: '#/purchases', foot: `${toFa(m.inventory.items.length)} قلم` }),
      moneyValue(m.sales.cogs_rial, { label: 'بهای تمام‌شدهٔ فروش این ماه', href: '#/pnl', foot: 'بر پایهٔ میانگین موزون' }),
    ]),
  );

  /* quick actions */
  root.appendChild(
    el('div', { class: 'quick' }, [
      el('a', { href: '#/sales?new=1' }, [el('span', { class: 'ico', text: '🧾' }), el('span', { text: 'ثبت فروش' })]),
      el('a', { href: '#/purchases?new=1' }, [el('span', { class: 'ico', text: '📦' }), el('span', { text: 'ثبت خرید' })]),
      el('a', { href: '#/expenses?new=1' }, [el('span', { class: 'ico', text: '💸' }), el('span', { text: 'ثبت هزینه' })]),
      el('a', { href: '#/fx?new=1' }, [el('span', { class: 'ico', text: '💵' }), el('span', { text: 'نرخ دلار' })]),
      el('a', { href: '#/accounts?tab=settle' }, [el('span', { class: 'ico', text: '💰' }), el('span', { text: 'وصول / پرداخت' })]),
      el('a', { href: '#/reports/monthly' }, [el('span', { class: 'ico', text: '🗓️' }), el('span', { text: 'گزارش ماهانه' })]),
    ]),
  );

  /* trend */
  const trend = data.trend || [];
  const hasData = trend.some((x) => x.net_rial !== 0 || x.net_sales_rial !== 0);
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [
        el('h2', { text: 'روند سود ۶ ماه گذشته' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'hint', style: 'margin:0', text: 'میله: سود خالص · خط: نرخ دلار (تومان)' }),
      ]),
      el('div', { class: 'card-b' }, [
        hasData
          ? barChart(
              trend.map((x) => ({
                label: x.label,
                shortLabel: x.label.split(' ')[0],
                value: x.net_rial,
                secondary: x.fx_end_rate_x100,
              })),
              { line: true, lineLabel: 'نرخ دلار', format: (v) => (Math.abs(v) > 100000 ? toFa(Math.round(v / 1000) + 'هزار') : toFa(Math.round(v))) },
            )
          : el('div', { class: 'empty' }, [el('div', { class: 'ico', text: '📈' }), el('p', { text: 'هنوز فروشی ثبت نشده است. با «ثبت فروش» شروع کنید — ارقام نمونه‌ای ساخته نمی‌شود.' })]),
        hasData
          ? el('div', { class: 'table-wrap', style: 'margin-top:10px' }, [
              tableOf(
                [
                  { label: 'ماه' },
                  { label: 'فروش خالص', num: true, render: (x) => money(x.net_sales_rial, { unit, withUnit: true }) },
                  { label: 'سود ناخالص', num: true, render: (x) => money(x.gross_rial, { unit, withUnit: true }) },
                  { label: 'سود خالص', num: true, render: (x) => `<span class="${x.net_rial < 0 ? 'neg' : 'pos'}">${money(x.net_rial, { unit, withUnit: true })}</span>` },
                ],
                [...trend].reverse(),
                { cls: 'table-compact' },
              ),
            ])
          : null,
      ]),
    ]),
  );

  /* recent activity */
  const recent = el('div', { class: 'grid cols-2' }, [
    recentCard('آخرین فاکتورهای فروش', data.quick.recent_sales, (r) => ({
      title: r.customer_name || 'مشتری بدون نام',
      sub: `${jalaliText(r.txn_date, { style: 'short' })} · ${(r.occurred_at || '').slice(11, 16) || ''}`,
      amount: r.header_discount_rial,
      raw: r,
    })),
    recentCard('آخرین هزینه‌ها', data.quick.recent_expenses, (r) => ({ title: r.category, sub: jalaliText(r.expense_date, { style: 'short' }), raw: r })),
  ]);
  root.appendChild(recent);

  host.appendChild(root);

  function recentCard(title, rows, map) {
    const list = el('div', { class: 'row-list' });
    if (!rows.length) list.appendChild(el('div', { class: 'notice info' }, ['چیزی ثبت نشده است.']));
    for (const r of rows) {
      const x = map(r);
      const rial = r.total_rial !== undefined ? r.total_rial : -r.amount_rial;
      list.appendChild(
        el('div', { class: 'row-item' }, [
          el('div', { class: 't' }, [el('b', { text: faCat(x.title) }), el('span', { text: x.sub })]),
          el('span', { class: `a ${rial < 0 ? 'neg' : 'pos'}`, text: money(rial, { unit, withUnit: true }) }),
        ]),
      );
    }
    return el('section', { class: 'card' }, [el('div', { class: 'card-h' }, [el('h2', { text: title })]), el('div', { class: 'card-b' }, [list])]);
  }
  const faCat = (t) => (t && /[\u0600-\u06FF]/.test(t) ? t : ({ rent: 'اجاره', salaries: 'حقوق', utilities: 'آب و برق', telecom: 'اینترنت', transport: 'حمل', taxes: 'مالیات', repairs: 'تعمیرات', packaging: 'بسته‌بندی', bank_fees: 'کارمزد', other: 'سایر' }[t] || t));
}
