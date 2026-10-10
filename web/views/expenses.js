// هزینه‌ها — one-screen quick entry with the 10 standard categories, plus the
// expense ledger, category breakdown and unpaid tracking.
import { el, clear, money, toFa, toast, dialog, jalaliText } from '../util.js';
import { MoneyField, Chips, SelectField, TextField, DateField, tableOf, displayUnit } from '../components.js';
import { get, post, put, del, stickyKey, releaseKey } from '../api.js';
import { state as appState } from '../app.js';

export async function render(host, { params, refresh }) {
  clear(host);
  const categories = appState.expenseCategories.length
    ? appState.expenseCategories
    : [
        { key: 'rent', label: 'اجاره' },
        { key: 'salaries', label: 'حقوق و دستمزد' },
        { key: 'utilities', label: 'آب، برق و گاز' },
        { key: 'telecom', label: 'اینترنت و تلفن' },
        { key: 'transport', label: 'حمل و نقل و توزیع' },
        { key: 'taxes', label: 'مالیات و عوارض' },
        { key: 'repairs', label: 'تعمیرات و نگهداری' },
        { key: 'packaging', label: 'بسته‌بندی' },
        { key: 'bank_fees', label: 'کارمزد بانکی و پرداخت' },
        { key: 'other', label: 'سایر هزینه‌ها' },
      ];
  const last = JSON.parse(localStorage.getItem('hs.lastExpense') || 'null');
  const date = DateField({});
  let category = params.get('cat') || last?.category || 'rent';
  const chips = el('div', { class: 'chips', style: 'display:grid;grid-template-columns:repeat(3,1fr);gap:7px' });
  const paintChips = () => {
    chips.replaceChildren();
    for (const c of categories) {
      chips.appendChild(
        el('button', {
          type: 'button',
          class: 'chip',
          style: 'justify-content:center;min-height:52px;font-size:13px',
          'aria-pressed': String(category === c.key),
          text: c.label,
          onclick: () => {
            category = c.key;
            paintChips();
          },
        }),
      );
    }
  };
  paintChips();
  const amount = MoneyField({ label: 'مبلغ هزینه *', value: last?.amount_toman || null });
  const method = Chips({
    label: 'روش پرداخت *',
    options: [
      { value: 'cash', label: '💵 نقدی' },
      { value: 'card', label: '💳 کارت' },
      { value: 'transfer', label: '🏦 انتقال' },
      { value: 'credit', label: '📝 پرداخت‌نشده (نسیه)' },
      { value: 'other', label: 'سایر' },
    ],
    value: last?.payment_method || 'cash',
    onChange: () => {
      if (method.value === 'credit') {
        paidLabel.textContent = 'پرداخت‌شده از این مبلغ (اختیاری)';
        paid.set(0);
      } else paidLabel.textContent = 'پرداخت‌شده (پیش‌فرض: کل مبلغ)';
    },
  });
  const paid = MoneyField({ label: 'پرداخت‌شده (پیش‌فرض: کل مبلغ)' });
  const paidLabel = paid.node.querySelector('label');
  const note = TextField({ label: 'شرح / یادداشت', placeholder: 'مثلاً قبض برق تابستان — شماره ۱۲۳۴' });
  const accounts = await get('/api/accounts').catch(() => ({ items: [] }));
  const account = SelectField({
    label: 'از کدام حساب کم شود؟',
    options: [{ value: '', label: 'حساب پیش‌فرض' }, ...(accounts.items || []).filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name }))],
    value: '',
  });
  const save = el('button', { class: 'btn block', text: 'ثبت هزینه', type: 'button' });

  save.addEventListener('click', async () => {
    const a = amount.rial();
    if (a === null || Number.isNaN(a) || a <= 0) return toast('مبلغ را وارد کنید.', { type: 'err' });
    save.disabled = true;
    try {
      const p = paid.rial();
      const body = {
        date: date.date(),
        category,
        amount_rial: a,
        payment_method: method.value,
        note: note.value() || undefined,
        dedupe_key: stickyKey('expense'),
      };
      if (p !== null && !Number.isNaN(p)) body.paid_rial = p;
      if (account.value()) body.account_id = Number(account.value());
      const out = await post('/api/expenses', body);
      releaseKey('expense');
      localStorage.setItem('hs.lastExpense', JSON.stringify({ category, payment_method: method.value }));
      toast(out.message || 'هزینه ثبت شد.');
      amount.clear();
      paid.clear();
      note.input.value = '';
      await refresh();
    } catch (e) {
      toast(e.message, { type: 'err', timeout: 6000 });
    } finally {
      save.disabled = false;
    }
  });

  const form = el('section', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h2', { text: 'ثبت هزینه' }), el('span', { class: 'spacer' }), el('span', { class: 'hint', style: 'margin:0', text: 'تاریخ امروز: ' + toFa(appState.clock.today || '') })]),
    el('div', { class: 'card-b' }, [date.node, el('div', { class: 'field' }, [el('label', { text: 'دستهٔ هزینه *' }), chips]), amount.node, el('details', {}, [el('summary', { style: 'font-weight:700;font-size:13px;cursor:pointer', text: 'روش پرداخت، حساب و شرح' }), el('div', { style: 'padding-top:10px' }, [method.node, paid.node, account.node, note.node])]), save]),
  ]);

  const list = el('section', { class: 'card' }, [
    el('div', { class: 'card-h' }, [
      el('h2', { text: 'هزینه‌های بازهٔ انتخابی' }),
      el('span', { class: 'spacer' }),
      el('a', { class: 'btn sm ghost', href: `/api/export.csv?table=expenses&${rangeQuery()}`, download: true, text: 'خروجی CSV' }),
    ]),
    el('div', { class: 'card-b', id: 'exp-list' }, [el('div', { class: 'notice info', text: 'در حال خواندن…' })]),
  ]);
  host.appendChild(el('div', { class: 'grid', style: 'gap:12px' }, [form, list]));
  loadList();

  async function loadList() {
    const data = await get(`/api/expenses?${rangeQuery()}`);
    const box = document.getElementById('exp-list');
    if (!box) return;
    const total = data.totals.amount_rial;
    const rows = Object.entries(data.totals.byCategory || {}).sort((a, b) => b[1] - a[1]);
    box.replaceChildren(
      el('div', { class: 'grid', style: 'gap:10px' }, [
        el('div', { class: 'grid cols-2' }, [
          el('div', { class: 'metric' }, [el('div', { class: 'label', text: 'جمع هزینه‌ها' }), el('div', { class: 'value', text: money(total, { unit: displayUnit(), withUnit: true }) })]),
          el('div', { class: 'metric' }, [el('div', { class: 'label', text: 'تعداد' }), el('div', { class: 'value', text: toFa(data.totals.count) })]),
        ]),
        rows.length
          ? el('div', { class: 'grid cols-2' }, rows.map(([k, v]) => el('div', { class: 'row-item' }, [el('div', { class: 't' }, [el('b', { text: categories.find((c) => c.key === k)?.label || k })]), el('span', { class: 'a', text: money(v, { unit: displayUnit(), withUnit: true }) }), el('span', { class: 'hint', text: total ? `${toFa(Math.round((v / total) * 100))}٪` : '' })])))
          : null,
        tableOf(
          [
            { label: 'تاریخ', render: (e) => jalaliText(e.expense_date, { style: 'short' }) },
            { label: 'دسته', render: (e) => e.category_label || e.category },
            { label: 'مبلغ', num: true, render: (e) => money(e.amount_rial, { unit: displayUnit(), withUnit: true }) },
            {
              label: 'پرداخت',
              render: (e) =>
                e.outstanding_rial > 0 ? el('span', { class: 'badge warn', text: `مانده ${money(e.outstanding_rial, { unit: displayUnit(), withUnit: false })}` }) : el('span', { class: 'badge ok', text: 'پرداخت شد' }),
            },
            { label: 'شرح', render: (e) => e.note || '—' },
            {
              label: '',
              render: (e) =>
                el('div', { style: 'display:flex;gap:6px' }, [
                  el('button', {
                    class: 'btn sm ghost',
                    text: 'ویرایش',
                    onclick: async () => {
                      const res = await dialog({
                        title: 'ویرایش هزینه',
                        confirmText: 'ذخیره',
                        fields: [
                          { name: 'amount_toman', label: 'مبلغ (تومان)', required: true, placeholder: String(Math.round(e.amount_rial / 10)) },
                          { name: 'note', label: 'شرح', placeholder: e.note || '' },
                          { name: 'reason', label: 'دلیل ویرایش *', required: true },
                        ],
                      });
                      if (!res?.ok) return;
                      await put(`/api/expenses/${e.id}`, { amount_toman: Number(res.values.amount_toman), note: res.values.note, reason: res.values.reason, category: e.category, date: e.expense_date, payment_method: e.payment_method });
                      toast('هزینه به‌روزرسانی شد.');
                      loadList();
                    },
                  }),
                  el('button', {
                    class: 'btn sm danger',
                    text: 'حذف',
                    onclick: async () => {
                      const res = await dialog({ title: 'حذف هزینه', body: 'با حذف این هزینه، سود دوره و گزارش‌های بسته‌شده تغییر می‌کنند (ثبت در سابقه).', confirmText: 'حذف', danger: true, fields: [{ name: 'reason', label: 'دلیل حذف *', required: true }] });
                      if (!res?.ok) return;
                      await del(`/api/expenses/${e.id}`, { reason: res.values.reason });
                      toast('هزینه حذف شد.');
                      loadList();
                    },
                  }),
                ]),
            },
          ],
          data.items,
          { empty: 'هنوز هزینه‌ای در این بازه ثبت نشده است.', cls: 'table-compact' },
        ),
      ]),
    );
  }
}

function rangeQuery() {
  const r = appState.range || { mode: 'month' };
  if (r.mode === 'custom' && r.from && r.to) return `from=${r.from}&to=${r.to}`;
  return `range=${r.mode || 'month'}`;
}
