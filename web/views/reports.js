// گزارش‌های ماهانه / سالانه — زنده در برابر نسخهٔ بسته‌شده (snapshot)، بستن دوره،
// بازمحاسبه با ثبت دلیل، چاپ و خروجی CSV.
import { el, clear, money, pct, toFa, toast, dialog, periodLabel, jalaliText } from '../util.js';
import { ReportBlocks, tableOf } from '../components.js';
import { get, post } from '../api.js';
import { state as appState } from '../app.js';

export async function render(host, { refresh, path }) {
  clear(host);
  const kind = path === '#/reports/yearly' ? 'year' : path === '#/reports/snapshots' ? 'snapshots' : 'month';
  const root = el('div', { class: 'grid', style: 'gap:12px' });
  host.appendChild(root);

  if (kind === 'snapshots') return snapshotsOnly(root, refresh);

  const [reportList, settings] = await Promise.all([get('/api/reports'), get('/api/settings')]);
  const periods = reportList.months.map((m) => m.period).filter(Boolean);
  const nowPeriod = appState.clock.today_period;
  const nowYear = appState.clock.this_year;
  if (kind === 'month' && !periods.includes(nowPeriod)) periods.unshift(nowPeriod);
  const allMonths = [];
  for (let i = 0; i < 18; i += 1) {
    const p = shift(periods[0] || nowPeriod, -i);
    if (!allMonths.includes(p)) allMonths.push(p);
  }
  if (kind === 'month' && !allMonths.includes(nowPeriod)) allMonths.unshift(nowPeriod);
  const years = [...new Set([nowYear, ...allMonths.map((p) => p.slice(0, 4)), ...periods.map((p) => p.slice(0, 4))])].sort().reverse();

  let period = kind === 'month' ? (allMonths.includes(currentPeriodFromRange(kind)) ? currentPeriodFromRange(kind) : nowPeriod) : nowYear;

  const sel = el(
    'select',
    { class: 'control', style: 'min-width:180px' },
    (kind === 'month' ? allMonths : years).map((o) => el('option', { value: o, selected: o === period, text: kind === 'month' ? periodLabel(o) : `سال ${toFa(o)}` })),
  );
  sel.addEventListener('change', () => {
    period = sel.value;
    paint();
  });

  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: kind === 'month' ? 'گزارش‌های ماهانه' : 'گزارش‌های سالانه' }), el('span', { class: 'spacer' }), sel]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'notice info' }, [
          'گزارش «زنده» همیشه از دفتر کل بازمحاسبه می‌شود. نسخهٔ «بسته‌شده» همان ارقامی است که در لحظٔهٔ بستن دوره ثبت شده و با تغییر نرخ دلار یا اصلاح داده‌های بعدی، خودبه‌خود بازنویسی نمی‌شود.',
        ]),
      ]),
    ]),
  );

  const body = el('div', { class: 'grid', style: 'gap:12px' });
  root.appendChild(body);
  paint();

  async function paint() {
    clear(body).appendChild(el('div', { class: 'skeleton', style: 'height:200px' }));
    try {
      const data =
        kind === 'month'
          ? await get(`/api/reports/monthly/${period}`)
          : await get(`/api/reports/yearly/${period}`);
      clear(body);
      body.appendChild(reportCard(data));
      if (kind === 'year') body.appendChild(yearExtras(data));
      body.appendChild(snapshotCard(data));
    } catch (e) {
      clear(body).appendChild(el('div', { class: 'card' }, [el('div', { class: 'card-b' }, [el('div', { class: 'notice bad', text: e.message })])]));
    }
  }

  function reportCard(data) {
    const report = data.report;
    const snap = data.snapshot;
    const actions = [
      el('button', { class: 'btn sm ghost', text: '🖨️ چاپ', onclick: () => window.print() }),
      el('a', {
        class: 'btn sm ghost',
        href: `/api/export.csv?table=${kind === 'month' ? 'monthly' : 'yearly'}`,
        download: true,
        text: 'CSV همهٔ دوره‌ها',
      }),
    ];
    return el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [
        el('h2', { text: `${kind === 'month' ? periodLabel(period) : `سال ${toFa(period)}`} — ارقام زنده` }),
        el('span', { class: 'spacer' }),
        ...actions,
      ]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'print-head' }, [el('b', { text: `هایپر سینا — گزارش ${kind === 'month' ? periodLabel(period) : toFa(period)}` })]),
        snap
          ? el('div', { class: 'notice' + (snap.differences && snap.differences.length ? ' warn' : ' info') }, [
              el('b', { text: `نسخهٔ بسته‌شده v${toFa(snap.version)} (${snap.status === 'final' ? 'نهایی' : snap.status === 'restated' ? 'بازمحاسبه‌شده' : 'پیش‌نویس'}) ثبت شده است. ` }),
              snap.differences && snap.differences.length
                ? `از آن زمان ${toFa(snap.differences.length)} رقم تغییر کرده است: ${snap.differences.map((d) => d.field).join('، ')}. برای به‌روز‌کردن نسخهٔ بسته‌شده از «بازمحاسبه» استفاده کنید.`
                : 'ارقام زنده با نسخهٔ بسته‌شده یکسان است.',
            ])
          : el('div', { class: 'notice info' }, ['برای این دوره هنوز گزارشی بسته نشده است.']),
        ...[ReportBlocks(report, { showReal: !!report.real_analysis, showReplacement: !!report.replacement_analysis }).children],
      ]),
    ]);
  }

  function yearExtras(data) {
    const r = data.report;
    if (!r.best_month) return null;
    return el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'بهترین و کم‌سودترین ماه' })]),
      el('div', { class: 'card-b grid cols-2' }, [
        el('div', { class: 'metric pos' }, [
          el('div', { class: 'label', text: 'بیشترین سود' }),
          el('div', { class: 'value', text: money(r.best_month.net_profit_rial, { withUnit: true }) }),
          el('div', { class: 'foot', text: `${r.best_month.label || periodLabel(r.best_month.period)} · حاشیه ${pct(r.best_month.net_margin_pct_x100)}` }),
        ]),
        el('div', { class: `metric ${r.worst_month.net_profit_rial < 0 ? 'neg' : ''}` }, [
          el('div', { class: 'label', text: 'کمترین سود' }),
          el('div', { class: 'value', text: money(r.worst_month.net_profit_rial, { withUnit: true }) }),
          el('div', { class: 'foot', text: `${r.worst_month.label || periodLabel(r.worst_month.period)} · حاشیه ${pct(r.worst_month.net_margin_pct_x100)}` }),
        ]),
      ]),
    ]);
  }

  function snapshotCard(data) {
    const snaps = kind === 'month' ? (data.snapshot ? [data.snapshot] : []) : data.snapshots || [];
    const host2 = el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'بستن دوره و بایگانی گزارش' })]),
      el('div', { class: 'card-b grid' }, [
        el('div', { class: 'notice' }, [
          'با «بستن ماه» یک نسخهٔ ثابت ساخته می‌شود که شامل جمع‌بندی محاسبه‌شده، نرخ دلار مبنای گزارش، فرض تورم استفاده‌شده، زمان محاسبه و شمارهٔ نسخه است. تغییرات بعدی نرخ دلار، این نسخه را دست نمی‌زند.',
        ]),
        data.report?.dataGaps?.blocking?.length
          ? el('div', { class: 'notice bad' }, [
              el('b', { text: 'کاستی داده که اجازهٔ گزارش نهایی نمی‌دهد: ' }),
              data.report.dataGaps.blocking.map((g) => g.message).join(' / '),
            ])
          : el('div', { class: 'notice' }, [el('b', { text: 'کنترل داده‌ها: ' }), 'کاستی بازدارنده‌ای وجود ندارد.']),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'btn',
            text: kind === 'month' ? 'بستن ماه و ذخیرهٔ گزارش' : 'بستن سال و ذخیرهٔ گزارش',
            disabled: !canOwner(),
            onclick: () => finalize(false),
          }),
          el('button', {
            class: 'btn subtle',
            text: 'ذخیره به‌عنوان پیش‌نویس (برآورد)',
            disabled: !canOwner(),
            onclick: () => finalize(true),
          }),
        ]),
        tableOf(
              [
                { label: 'نسخه', num: true, render: (s) => toFa(s.version ?? 1) },
                { label: 'وضعیت', render: (s) => el('span', { class: `badge ${s.status === 'final' ? 'ok' : s.status === 'restated' ? 'warn' : 'info'}`, text: s.status === 'final' ? 'نهایی' : s.status === 'restated' ? 'بازمحاسبه' : 'پیش‌نویس' }) },
                { label: 'زمان محاسبه', render: (s) => jalaliText((s.computed_at || '').slice(0, 10), { style: 'short' }) + ' ' + toFa((s.computed_at || '').slice(11, 16)) },
                { label: 'نرخ دلار مبنای گزارش', render: (s) => (s.fx_end_date ? `${jalaliText(s.fx_end_date, { style: 'short' })}` : '—') },
                { label: 'دورهٔ پایهٔ تورم', render: (s) => (s.inflation_base_period ? periodLabel(s.inflation_base_period) : '—') },
                { label: 'یادداشت', render: (s) => s.note || '—' },
                {
                  label: '',
                  render: (s) =>
                    el('div', { style: 'display:flex;gap:6px' }, [
                      el('button', { class: 'btn sm ghost', text: 'مشاهدهٔ نسخه', onclick: () => viewSnapshot(s.id) }),
                      canOwner()
                        ? el('button', { class: 'btn sm subtle', text: 'بازمحاسبه', onclick: () => recalculate(s.id) })
                        : null,
                    ]),
                },
              ],
          snaps,
          { empty: 'برای این دوره نسخه‌ای ذخیره نشده است.' },
        ),
      ]),
    ]);
    return host2;

    async function finalize(draft) {
      const res = await dialog({
        title: draft ? 'ذخیرهٔ پیش‌نویس' : kind === 'month' ? 'بستن ماه' : 'بستن سال',
        body: draft
          ? 'پیش‌نویس با برچسب «برآورد» ذخیره می‌شود و گزارش نهایی محسوب نمی‌گردد.'
          : 'با این کار نسخهٔ ثابتی ساخته می‌شود که دیگر با تغییر نرخ دلار یا ویرایش داده‌ها بازنویسی نمی‌شود. برای تغییر بعدی باید «بازمحاسبه» با ذکر دلیل انجام شود.',
        confirmText: 'ذخیره',
        fields: [{ name: 'note', label: 'یادداشت این نسخه (اختیاری)', multiline: true }],
      });
      if (!res?.ok) return;
      try {
        const out = await post(`/api/reports/${kind === 'month' ? 'monthly' : 'yearly'}/${period}/finalize`, { status: draft ? 'draft' : 'final', note: res.values.note || undefined });
        toast(out.message || 'ذخیره شد.');
        await refresh();
      } catch (e) {
        toast(`${e.message}${e.details?.hint ? ` ${e.details.hint}` : ''}`, { type: 'err', timeout: 9000 });
      }
    }

    async function recalculate(id) {
      const res = await dialog({
        title: 'بازمحاسبهٔ گزارش بسته‌شده',
        body: 'نسخهٔ قبلی در بایگانی می‌ماند و یک نسخهٔ جدید با ذکر دلیل ساخته می‌شود (سابقهٔ تغییرات حفظ می‌شود).',
        confirmText: 'بازمحاسبه و ساخت نسخهٔ جدید',
        fields: [{ name: 'reason', label: 'دلیل بازمحاسبه *', required: true, multiline: true, placeholder: 'مثلاً اصلاح فاکتور خرید یک ماه قبل' }],
      });
      if (!res?.ok) return;
      try {
        const out = await post(`/api/snapshots/${id}/recalculate`, { reason: res.values.reason });
        toast(out.message);
        await refresh();
      } catch (e) {
        toast(e.message, { type: 'err' });
      }
    }
  }

  async function viewSnapshot(id) {
    const dlg = el('dialog');
    dlg.appendChild(el('div', { class: 'card-h' }, [el('h3', { text: `نسخهٔ بایگانی‌شده ${toFa(id)}` }), el('span', { class: 'spacer' }), el('button', { class: 'btn sm ghost', text: 'بستن', onclick: () => dlg.close() })]));
    const box = el('div', { class: 'card-b' }, [el('div', { class: 'notice info', text: 'در حال خواندن…' })]);
    dlg.appendChild(box);
    document.getElementById('modal-root').appendChild(dlg);
    dlg.showModal();
    try {
      const snap = await get(`/api/snapshots/${id}`);
      box.replaceChildren(
        el('div', { class: 'grid', style: 'gap:10px' }, [
          el('div', { class: 'notice' }, [
            el('b', { text: `دوره ${snap.period}${snap.period_type === 'month' ? ' (' + periodLabel(snap.period) + ')' : ''} · نسخه v${toFa(snap.version)} · ` }),
            snap.status === 'final' ? 'نهایی' : snap.status === 'restated' ? 'بازمحاسبه‌شده' : 'پیش‌نویس',
            ` · زمان محاسبه: ${jalaliText((snap.computed_at || '').slice(0, 10), { style: 'short' })} ${toFa((snap.computed_at || '').slice(11, 16))}`,
            snap.note ? ` · «${snap.note}»` : '',
          ]),
          el('div', { class: 'notice warn' }, [
            'این ارقام ثابت‌اند. نرخ دلار مبنای این نسخه: ',
            snap.fx_end_date ? jalaliText(snap.fx_end_date, { style: 'short' }) : 'ثبتی نداشت',
            ' · دورهٔ پایهٔ تورم: ',
            snap.inflation_base_period ? periodLabel(snap.inflation_base_period) : '—',
          ]),
          snap.corrections?.length
            ? el('div', { class: 'notice info' }, [el('b', { text: 'سابقهٔ اصلاحات: ' }), snap.corrections.map((c) => `${c.reason} (${jalaliText(c.created_at.slice(0, 10), { style: 'short' })})`).join(' / ')])
            : null,
          ReportBlocks(snap.report, { showReal: !!snap.report.real_analysis, showReplacement: !!snap.report.replacement_analysis }),
        ]),
      );
    } catch (e) {
      box.replaceChildren(el('div', { class: 'notice bad', text: e.message }));
    }
  }

  async function snapshotsOnly(rootNode, refresh) {
    const data = await get('/api/snapshots');
    rootNode.appendChild(
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'همهٔ گزارش‌های بایگانی‌شده' })]),
        el('div', { class: 'card-b' }, [
          tableOf(
            [
              { label: 'دوره', render: (s) => el('b', { text: s.period_type === 'month' ? periodLabel(s.period) : `سال ${toFa(s.period)}` }) },
              { label: 'نسخه', num: true, render: (s) => toFa(s.version) },
              { label: 'وضعیت', render: (s) => el('span', { class: `badge ${s.status === 'final' ? 'ok' : s.status === 'restated' ? 'warn' : 'info'}`, text: s.status === 'final' ? 'نهایی' : s.status === 'restated' ? 'بازمحاسبه' : 'پیش‌نویس' }) },
              { label: 'نرخ دلار مبنای دوره', render: (s) => (s.fx_end_date ? jalaliText(s.fx_end_date, { style: 'short' }) : '—') },
              { label: 'زمان محاسبه', render: (s) => jalaliText((s.computed_at || '').slice(0, 10), { style: 'short' }) },
              { label: 'یادداشت', render: (s) => s.note || '—' },
            ],
            data.items,
            { empty: 'هنوز گزارشی بسته نشده است. از «گزارش‌های ماهانه» یک دوره را ببندید.' },
          ),
        ]),
      ]),
    );
  }
}

const canOwner = () => appState.me?.role === 'owner';

function currentPeriodFromRange(kind) {
  const r = appState.range || {};
  if (r.period) return r.period;
  if (kind === 'year') return appState.clock.this_year;
  if (r.mode === 'prev') return shift(appState.clock.today_period, -1);
  return appState.clock.today_period;
}

function shift(period, delta) {
  const [y, m] = String(period).split('-').map(Number);
  let ny = y;
  let nm = m + delta;
  while (nm < 1) { nm += 12; ny -= 1; }
  while (nm > 12) { nm -= 12; ny += 1; }
  return `${ny}-${String(nm).padStart(2, '0')}`;
}
