// مدیریت دلار و تورم — manual USD rate entry & history, plus manual inflation
// assumptions. Nothing is ever fetched or guessed automatically.
import { el, clear, money, pct, rate, toFa, toast, dialog, jalaliText, periodLabel } from '../util.js';
import { MoneyField, TextField, DateField, SelectField, tableOf, displayUnit } from '../components.js';
import { get, post, del } from '../api.js';
import { lineChart } from '../charts.js';
import { state as appState } from '../app.js';

export async function render(host, { params, refresh }) {
  clear(host);
  const unit = displayUnit();
  const period = params.get('period') || appState.clock.today_period;
  const [fx, inflation] = await Promise.all([get(`/api/fx?limit=400&${rangeQ()}`), get('/api/inflation')]);
  const summary = fx.summary;
  const root = el('div', { class: 'grid', style: 'gap:12px' });

  root.appendChild(
    el('div', { class: 'notice warn' }, [
      el('b', { text: 'همه‌چیز دستی است. ' }),
      'این برنامه هرگز نرخ دلار یا نرخ تورم را از اینترنت نمی‌گیرد و حدس نمی‌زند. عددی که می‌بینید فقط همان چیزی است که خودتان ثبت کرده‌اید؛ هر تاریخ یک رکورد جدا دارد و ثبت نرخ امروز، نرخ روزهای قبل را پاک نمی‌کند.',
    ]),
  );

  /* ---------------------------------------------------------- entry form */
  const date = DateField({});
  date.node.replaceChildren();
  const rateDate = el('input', { class: 'control', type: 'date', value: appState.clock.today, max: appState.clock.today });
  const rateField = MoneyField({ label: 'نرخ هر دلار (تومان) *', hint: 'مثلاً ۹۵۰۰۰۰' });
  const note = TextField({ label: 'یادداشت (اختیاری)', placeholder: 'مثلاً نرخ صرافی میدان فردوسی — عصر' });
  const save = el('button', { class: 'btn block', text: 'ذخیرهٔ نرخ دلار', type: 'button' });
  save.addEventListener('click', async () => {
    const r = rateField.rial();
    if (!r || Number.isNaN(r) || r <= 0) return toast('نرخ معتبر وارد کنید.', { type: 'err' });
    save.disabled = true;
    try {
      const res = await dialog({
        title: 'تأیید ثبت نرخ دلار',
        body: `نرخ ${money(r, { unit: 'toman', withUnit: true })} برای تاریخ ${jalaliText(rateDate.value, { style: 'short' })} ثبت می‌شود.${
          fx.items.some((i) => i.effective_date === rateDate.value) ? ' برای این تاریخ رکوردی وجود دارد و با همین مقدار اصلاح می‌شود (مقادیر روزهای دیگر دست‌نخورده می‌ماند).' : ''
        }`,
        confirmText: 'ثبت',
      });
      if (!res) return;
      const out = await post('/api/fx', { effective_date: rateDate.value, rate_rial: r, note: note.value() || undefined });
      toast(out.message || 'نرخ ذخیره شد.');
      await refresh();
    } catch (e) {
      toast(e.message, { type: 'err', timeout: 6000 });
    } finally {
      save.disabled = false;
    }
  });

  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'ثبت نرخ دلار' }), el('span', { class: 'spacer' }), el('span', { class: 'badge', text: 'واحد: تومان' })]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'grid cols-2' }, [
          el('div', { class: 'field' }, [el('label', { text: 'تاریخ نرخ *' }), rateDate, el('div', { class: 'hint', text: 'اگر برای همان تاریخ رکوردی باشد، همان رکورد اصلاح می‌شود و «دلیل اصلاح» در سابقه می‌ماند.' })]),
          rateField.node,
        ]),
        note.node,
        save,
      ]),
    ]),
  );

  /* -------------------------------------------------------------- summary */
  const latest = summary.latest;
  const changeAbs = summary.change_abs_x100;
  root.appendChild(
    el('div', { class: 'grid cols-4' }, [
      metric('آخرین نرخ ثبت‌شده', latest ? rate(latest.rate_toman_x100) : '—', latest ? `در ${jalaliText(latest.effective_date, { style: 'short' })}` : 'هنوز رکوردی ندارید'),
      metric('نرخ قبلی', summary.previous ? rate(summary.previous.rate_toman_x100) : '—', summary.previous ? `در ${jalaliText(summary.previous.effective_date, { style: 'short' })}` : 'کمتر از دو رکورد ثبت شده'),
      metric(
        'تغییر (مطلق)',
        changeAbs === null ? '—' : `${changeAbs > 0 ? '▲' : changeAbs < 0 ? '▼' : '•'} ${money(Math.abs(Math.round(changeAbs / 10)), { unit: 'toman', withUnit: true }).replace('−', '')}`,
        null,
        changeAbs === null ? '' : changeAbs > 0 ? 'neg' : 'pos',
      ),
      metric('تغییر نسبی', summary.change_pct_x100 === null ? '—' : pct(summary.change_pct_x100), 'نسبت به رکورد قبلی', summary.change_pct_x100 > 0 ? 'neg' : summary.change_pct_x100 < 0 ? 'pos' : ''),
    ]),
  );

  root.appendChild(
    el('div', { class: 'grid cols-2' }, [
      metric(`میانگین ثبت‌های این دوره (${toFa(summary?.period?.records_in_period || 0)} رکورد)`, summary?.period?.avg_rate_x100 ? rate(summary.period.avg_rate_x100) : '—', 'میانگین نرخ‌های خودتان است، نه میانگین رسمی بازار'),
      metric(`تغییر نرخ در ${periodLabel(period)}`, summary?.period?.change_pct_x100 === null ? '—' : pct(summary.period.change_pct_x100), `ابتدا ${rate(summary?.period?.start_rate_x100)} ← پایان ${rate(summary?.period?.end_rate_x100)}`),
    ]),
  );

  /* -------------------------------------------------------------- chart */
  const series = fx.series || [];
  if (series.length > 1) {
    root.appendChild(
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [
          el('h2', { text: 'نمودار نرخ دلار' }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'hint', style: 'margin:0', text: `${toFa(series.length)} رکورد` }),
        ]),
        el('div', { class: 'card-b' }, [
          lineChart(
            series.map((p) => ({ label: jalaliText(p.date, { style: 'short' }), shortLabel: p.date.slice(5).replace('-', '/'), value: p.rate_toman_x100 / 100 })),
            { height: 170, labelEvery: Math.max(1, Math.ceil(series.length / 8)), format: (v) => toFa(Math.round(v / 1000)) + 'هزار' },
          ),
        ]),
      ]),
    );
  } else if (series.length === 1) {
    root.appendChild(el('div', { class: 'notice info' }, ['برای دیدن نمودار به حداقل دو رکورد نرخ در تاریخ‌های مختلف نیاز است.']));
  }

  /* -------------------------------------------------------------- history */
  const historyRows = await get(`/api/fx?limit=400`).then((d) => d.items);
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [
        el('h2', { text: 'تاریخچهٔ نرخ‌ها (همان روزها حفظ می‌شوند)' }),
        el('span', { class: 'spacer' }),
        el('a', { class: 'btn sm ghost', href: '/api/export.csv?table=fx', download: true, text: 'CSV' }),
      ]),
      el('div', { class: 'card-b' }, [
        tableOf(
          [
            { label: 'تاریخ', render: (r) => el('b', { text: jalaliText(r.effective_date, { style: 'short' }) }) },
            { label: 'نرخ (تومان)', num: true, render: (r) => rate(r.rate_toman_x100) },
            {
              label: 'تغییر با قبلی',
              num: true,
              render: (r) => {
                const i = historyRows.findIndex((x) => x.id === r.id);
                const prev = historyRows[i + 1];
                if (!prev) return '—';
                const d = r.rate_toman_x100 - prev.rate_toman_x100;
                return el('span', { class: d > 0 ? 'neg' : 'pos', text: `${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${pct(Math.round((d / prev.rate_toman_x100) * 10000))}` });
              },
            },
            { label: 'یادداشت', render: (r) => r.note || '—' },
            { label: 'وضعیت', render: (r) => (r.updated_at ? el('span', { class: 'badge warn', text: 'اصلاح‌شده' }) : el('span', { class: 'badge ok', text: 'تازه' })) },
            {
              label: 'برای گزارش این دوره',
              render: (r) =>
                el('div', { style: 'display:flex;gap:6px' }, [
                  el('button', {
                    class: 'btn sm ghost',
                    text: 'اصلاح',
                    onclick: async () => {
                      const res = await dialog({
                        title: `اصلاح نرخ ${jalaliText(r.effective_date, { style: 'short' })}`,
                        body: 'رکورد همین تاریخ اصلاح می‌شود؛ مقدار قبلی در «سابقهٔ تغییرات» می‌ماند و گزارش‌های بسته‌شده خودکار بازنویسی نمی‌شوند.',
                        confirmText: 'ذخیرهٔ اصلاح',
                        fields: [
                          { name: 'rate_toman', label: 'نرخ جدید (تومان) *', required: true, placeholder: String(Math.round(r.rate_toman_x100 / 100)) },
                          { name: 'reason', label: 'دلیل اصلاح *', required: true },
                        ],
                      });
                      if (!res?.ok) return;
                      await post('/api/fx', { effective_date: r.effective_date, rate_toman: Number(res.values.rate_toman), reason: res.values.reason, note: r.note || undefined });
                      toast('اصلاح شد.');
                      refresh();
                    },
                  }),
                  el('button', {
                    class: 'btn sm subtle',
                    text: 'مبنای گزارش',
                    title: 'این رکورد را برای نرخ انتهای گزارش همین دوره انتخاب کنید',
                    onclick: async () => {
                      await post('/api/fx/choice', { period_type: 'month', period, fx_rate_id: r.id });
                      toast(`نرخ این رکورد در گزارش ${periodLabel(period)} استفاده می‌شود.`);
                      refresh();
                    },
                  }),
                ]),
            },
          ],
          historyRows,
          { empty: 'هنوز نرخی ثبت نکرده‌اید.', cls: 'table-compact' },
        ),
        el('div', { class: 'notice info' }, [
          'نرخ مبنای گزارش ماهانه به‌صورت خودکار «آخرین رکوردِ تا پایان ماه» است. اگر می‌خواهید رکورد دیگری مبنای ',
          periodLabel(period),
          ' باشد، با دکمهٔ «مبنای گزارش» انتخابش کنید. ',
          el('button', {
            class: 'btn sm ghost',
            text: 'لغو انتخاب دستی',
            onclick: async () => {
              await post('/api/fx/choice', { period_type: 'month', period, fx_rate_id: 'auto' });
              refresh();
            },
          }),
        ]),
      ]),
    ]),
  );

  /* --------------------------------------------------- inflation module */
  const infDate = SelectField({
    label: 'ماه جلالی *',
    options: inflationPeriods(18).map((p) => ({ value: p, label: periodLabel(p) })),
    value: period,
  });
  const infRate = MoneyField({ label: '٪ تورم ماهانه (فرض شما) *', hint: 'مثلاً ۳٫۵' });
  infRate.input.setAttribute('inputmode', 'decimal');
  const infNote = TextField({ label: 'مبنى فرض (اختیاری)', placeholder: 'مثلاً سبد خرید پرتکرار مغازه' });
  const infSave = el('button', { class: 'btn', text: 'ذخیرهٔ فرض تورم', type: 'button' });
  infSave.addEventListener('click', async () => {
    const raw = infRate.input.value.trim();
    if (!raw) return toast('درصد تورم را وارد کنید.', { type: 'err' });
    infSave.disabled = true;
    try {
      await post('/api/inflation', { period: infDate.value(), rate_pct: raw, note: infNote.value() || undefined });
      toast('فرض تورم ذخیره شد. این عدد رسمی نیست.');
      await refresh();
    } catch (e) {
      toast(e.message, { type: 'err', timeout: 6000 });
    } finally {
      infSave.disabled = false;
    }
  });

  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'فرض تورم ماهانه' }), el('span', { class: 'spacer' }), el('span', { class: 'estimate-tag', text: 'فرض دستی — نرخ رسمی نیست' })]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'notice warn' }, ['تورم و نرخ دلار دو شاخص جدا هستند. برنامه هیچ‌وقت درصد تغییر دلار را به‌جای نرخ تورم استفاده نمی‌کند.']),
        el('div', { class: 'grid cols-2' }, [infDate.node, el('div', { class: 'field' }, [el('label', { text: 'درصد تورم ماهانه *' }), rateLikeHost(infRate)])]),
        infNote.node,
        el('a', { class: 'btn subtle', href: `#/real-profit?period=${period}`, text: 'دیدن سود واقعی و اثر تورم' }),
        infSave,
      ]),
    ]),
  );

  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'سابقهٔ فرض‌های تورم' })]),
      el('div', { class: 'card-b' }, [
        tableOf(
          [
            { label: 'ماه', render: (i) => el('b', { text: i.label }) },
            { label: 'درصد', num: true, render: (i) => pct(i.rate_pct_x100) },
            { label: 'یادداشت', render: (i) => i.note || '—' },
            {
              label: '',
              render: (i) =>
                el('button', {
                  class: 'btn sm danger',
                  text: 'حذف',
                  onclick: async () => {
                    if (appState.me.role !== 'owner') return toast('حذف فرض تورم فقط برای مالک است.', { type: 'err' });
                    const res = await dialog({ title: 'حذف فرض تورم', body: 'با حذف این ماه، سود واقعی ماه‌های بعد قابل محاسبه نخواهد بود.', confirmText: 'حذف', danger: true });
                    if (!res) return;
                    await del(`/api/inflation/${i.period}`);
                    refresh();
                  },
                }),
            },
          ],
          inflation.items,
          { empty: 'هنوز فرض تورمی ثبت نشده است.' },
        ),
      ]),
    ]),
  );

  host.appendChild(root);
}

function rateLikeHost(field) {
  return field.node;
}

function metric(label, value, foot = null, cls = '') {
  const unit = displayUnit();
  return el('div', { class: `metric ${cls}` }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: value }), foot ? el('div', { class: 'foot', text: foot }) : null]);
}

function inflationPeriods(n) {
  const out = [];
  let p = appState.clock.today_period;
  for (let i = 0; i < n; i += 1) {
    out.push(p);
    const [y, m] = p.split('-').map(Number);
    let ny = y;
    let nm = m - 1;
    if (nm < 1) {
      nm = 12;
      ny -= 1;
    }
    p = `${ny}-${String(nm).padStart(2, '0')}`;
  }
  return out;
}

function rangeQ() {
  const r = appState.range || { mode: 'month' };
  if (r.mode === 'custom' && r.from && r.to) return `from=${r.from}&to=${r.to}`;
  return `range=${r.mode || 'month'}`;
}
