// صندوق و حساب‌ها — cash/bank accounts, collections & payments, owner capital,
// loans and pre-adoption opening balances. Capital and loan principal are shown
// separately from profit on purpose.
import { el, clear, money, toFa, toast, dialog, jalaliText, parseNum } from '../util.js';
import { MoneyField, Chips, TextField, DateField, tableOf, displayUnit } from '../components.js';
import { get, post, put, del, stickyKey, releaseKey } from '../api.js';
import { state as appState } from '../app.js';

export async function render(host, { params, refresh }) {
  clear(host);
  const unit = displayUnit();
  const r = appState.range || { mode: 'month' };
  const q = r.mode === 'custom' && r.from && r.to ? `from=${r.from}&to=${r.to}` : `range=${r.mode || 'month'}`;
  const [accounts, settlements, financials, month] = await Promise.all([
    get(`/api/accounts?${q}`),
    get(`/api/settlements?${q}`),
    get(`/api/financials?${q}`),
    get(`/api/reports/monthly/${appState.clock.today_period}?as_of=live`).catch(() => null),
  ]);

  const tabs = [
    { key: 'summary', label: 'خلاصه' },
    { key: 'settle', label: 'وصول و پرداخت' },
    { key: 'accounts', label: 'صندوق‌ها و حساب‌ها' },
    { key: 'capital', label: 'سرمایه و وام' },
  ];
  let active = params.get('tab') || 'summary';
  const bar = el('div', { class: 'chips' });
  for (const t of tabs) {
    bar.appendChild(
      el('button', {
        class: 'chip',
        type: 'button',
        text: t.label,
        'aria-pressed': String(active === t.key),
        onclick: () => {
          active = t.key;
          [...bar.children].forEach((c, i) => c.setAttribute('aria-pressed', String(tabs[i].key === active)));
          paint();
        },
      }),
    );
  }
  const body = el('div');
  host.appendChild(el('div', { class: 'grid', style: 'gap:12px' }, [bar, body]));
  paint();

  function paint() {
    clear(body);
    if (active === 'summary') body.appendChild(summary());
    if (active === 'settle') body.appendChild(settleCard());
    if (active === 'accounts') body.appendChild(accountsCard());
    if (active === 'capital') body.appendChild(capitalCard());
  }

  function summary() {
    const rep = month?.report;
    return el('div', { class: 'grid', style: 'gap:12px' }, [
      el('div', { class: 'grid cols-2' }, [
        metric('نقد در صندوق و بانک (پایان دوره)', accounts.items.reduce((a, x) => a + x.closing_rial, 0), `اول بازه: ${money(accounts.items.reduce((a, x) => a + x.opening_period_rial, 0), { unit, withUnit: true })}`),
        metric('ورودی نقد این بازه', sumMov(accounts.movements, 1)),
        metric('خروجی نقد این بازه', -sumMov(accounts.movements, -1)),
        metric('طلب از مشتریان', rep?.receivables.closing_rial ?? accounts.receivables, `${toFa(rep?.receivables.byParty.length ?? 0)} مشتری`),
        metric('بدهی به تأمین‌کنندگان', rep?.payables.closing_rial ?? accounts.payables, `${toFa(rep?.payables.byParty.length ?? 0)} تأمین‌کننده`),
        metric('تغییر خالص نقد', (accounts.items.reduce((a, x) => a + x.closing_rial, 0) || 0) - (accounts.items.reduce((a, x) => a + x.opening_period_rial, 0) || 0)),
      ]),
      accounts.unassigned_rial
        ? el('div', { class: 'notice warn' }, [`بخشی از وجوه به حسابی متصل نیست (${money(accounts.unassigned_rial, { unit, withUnit: true })}). برای دقیق‌شدن موجودی، هنگام ثبت تراکنش حساب را انتخاب کنید.`])
        : null,
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'جنبش حساب‌ها' })]),
        el('div', { class: 'card-b' }, [
          tableOf(
            [
              { label: 'حساب', render: (m) => el('b', { text: m.account_name }) },
              { label: 'تاریخ', render: (m) => jalaliText(m.d, { style: 'short' }) },
              { label: 'شرح', render: (m) => m.label },
              { label: 'مبلغ', num: true, render: (m) => el('span', { class: m.amt > 0 ? 'pos' : 'neg', text: money(m.amt, { unit, withUnit: true }) }) },
            ],
            accounts.movements,
            { empty: 'جنبش نقدی در این بازه ثبت نشده است.', cls: 'table-compact' },
          ),
        ]),
      ]),
    ]);
  }

  function sumMov(rows, sign) {
    return (rows || []).filter((m) => (sign > 0 ? m.amt > 0 : m.amt < 0)).reduce((a, m) => a + (sign > 0 ? m.amt : -m.amt), 0);
  }

  function settleCard() {
    const openSales = (rep?.receivables.byParty || []).slice(0, 8);
    const host2 = el('div', { class: 'grid cols-2' }, [
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'وصول مطالبات از مشتری' })]),
        el('div', { class: 'card-b' }, [form(true)]),
      ]),
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'پرداخت به تأمین‌کننده' })]),
        el('div', { class: 'card-b' }, [form(false)]),
      ]),
    ]);
    const list = el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'تسویه‌های این بازه' })]),
      el('div', { class: 'card-b' }, [
        tableOf(
          [
            { label: 'تاریخ', render: (s) => jalaliText(s.txn_date, { style: 'short' }) },
            { label: 'نوع', render: (s) => el('span', { class: `badge ${s.type === 'customer_receipt' ? 'ok' : 'warn'}`, text: s.type === 'customer_receipt' ? 'وصول از مشتری' : 'پرداخت به تأمین‌کننده' }) },
            { label: 'طرف حساب', render: (s) => s.customer_name || s.supplier_name || '—' },
            { label: 'مبلغ', num: true, render: (s) => money(s.amount_rial, { unit, withUnit: true }) },
            {
              label: '',
              render: (s) =>
                el('button', {
                  class: 'btn sm danger',
                  text: 'حذف',
                  onclick: async () => {
                    const res = await dialog({ title: 'حذف تسویه', confirmText: 'حذف', danger: true, fields: [{ name: 'reason', label: 'دلیل *', required: true }] });
                    if (!res?.ok) return;
                    await del(`/api/settlements/${s.id}`, { reason: res.values.reason });
                    toast('حذف شد.');
                    refresh();
                  },
                }),
            },
          ],
          settlements.items,
          { empty: 'تسویه‌ای در این بازه ثبت نشده است.' },
        ),
      ]),
    ]);
    return el('div', { class: 'grid', style: 'gap:12px' }, [host2, list]);

    function form(isReceipt) {
      const date = DateField({});
      const amount = MoneyField({ label: 'مبلغ *' });
      const party = TextField({ label: isReceipt ? 'نام مشتری' : 'نام تأمین‌کننده', placeholder: isReceipt ? 'برای تطبیق با فاکتور باز' : 'مثلاً بازرگانی امید' });
      const invoice = TextField({ label: isReceipt ? 'شماره فاکتور فروش (اختیاری)' : 'شماره فاکتور خرید (اختیاری)', placeholder: 'مثلاً ۱۲' });
      const method = Chips({
        label: 'روش',
        options: isReceipt
          ? [
              { value: 'cash', label: '💵 نقدی' },
              { value: 'card', label: '💳 کارت' },
              { value: 'transfer', label: '🏦 انتقال' },
            ]
          : [
              { value: 'cash', label: '💵 نقدی' },
              { value: 'card', label: '💳 کارت' },
              { value: 'transfer', label: '🏦 انتقال' },
            ],
        value: 'cash',
      });
      const note = TextField({ label: 'یادداشت' });
      const btn = el('button', { class: 'btn block', text: isReceipt ? 'ثبت وصول' : 'ثبت پرداخت', type: 'button' });
      btn.addEventListener('click', async () => {
        const a = amount.rial();
        if (!a || Number.isNaN(a)) return toast('مبلغ را وارد کنید.', { type: 'err' });
        btn.disabled = true;
        try {
          const body = {
            type: isReceipt ? 'customer_receipt' : 'supplier_payment',
            date: date.date(),
            amount_rial: a,
            payment_method: method.value,
            note: note.value() || undefined,
            dedupe_key: stickyKey(isReceipt ? 'receipt' : 'pay'),
          };
          if (isReceipt) body.customer_name = party.value() || undefined;
          else body.supplier_name = party.value() || undefined;
          const inv = parseNum(invoice.value());
          if (!Number.isNaN(inv) && inv > 0) {
            if (isReceipt) body.sale_id = Math.round(inv);
            else body.purchase_id = Math.round(inv);
          }
          const out = await post('/api/settlements', body);
          releaseKey(isReceipt ? 'receipt' : 'pay');
          toast(out.message || 'ثبت شد.');
          amount.clear();
          note.input.value = '';
          invoice.input.value = '';
          await refresh();
        } catch (e) {
          toast(e.message, { type: 'err', timeout: 7000 });
        } finally {
          btn.disabled = false;
        }
      });
      return el('div', { class: 'grid' }, [
        el('div', { class: 'notice info' }, [
          isReceipt
            ? 'اگر شماره فاکتور را وارد کنید، دقیقاً همان فاکتور تسویه می‌شود؛ در غیر این صورت مبلغ به حساب کلی آن مشتری می‌نشیند.'
            : 'با وارد کردن شماره فاکتور خرید، ماندهٔ همان فاکتور کم می‌شود؛ در غیر صورت از قدیمی‌ترین بدهی آن تأمین‌کننده کسر می‌گردد.',
        ]),
        date.node,
        amount.node,
        party.node,
        invoice.node,
        method.node,
        note.node,
        btn,
      ]);
    }
  }

  function accountsCard() {
    const name = TextField({ label: 'نام حساب *', placeholder: 'مثلاً صندوق مغازه / حساب ملی' });
    const type = Chips({ label: 'نوع', options: [{ value: 'cash', label: 'صندوق نقدی' }, { value: 'bank', label: 'حساب بانکی' }], value: 'cash' });
    const opening = MoneyField({ label: 'موجودی بازگشایی (اختیاری)' });
    const btn = el('button', { class: 'btn', text: 'افزودن حساب', type: 'button' });
    btn.addEventListener('click', async () => {
      if (!name.value()) return toast('نام حساب را وارد کنید.', { type: 'err' });
      try {
        const body = { name: name.value(), type: type.value };
        const o = opening.rial();
        if (o && !Number.isNaN(o)) body.opening_balance_rial = o;
        await post('/api/accounts', body);
        toast('حساب ساخته شد.');
        await refresh();
      } catch (e) {
        toast(e.message, { type: 'err' });
      }
    });
    return el('div', { class: 'grid cols-2' }, [
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'افزودن صندوق / حساب' })]),
        el('div', { class: 'card-b' }, [
          el('div', { class: 'notice info' }, ['موجودی هر حساب از تراکنش‌ها محاسبه می‌شود؛ «موجودی بازگشایی» تنها برای ماندهٔ روزِ اول استفاده می‌شود.']),
          name.node,
          type.node,
          opening.node,
          btn,
        ]),
      ]),
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'حساب‌ها' })]),
        el('div', { class: 'card-b' }, [
          tableOf(
            [
              { label: 'حساب', render: (a) => el('b', { text: a.name + (a.is_default ? ' (پیش‌فرض)' : '') }) },
              { label: 'نوع', render: (a) => (a.type === 'cash' ? 'صندوق' : 'بانک') },
              { label: 'اول بازه', num: true, render: (a) => money(a.opening_period_rial, { unit, withUnit: true }) },
              { label: 'اکنون', num: true, render: (a) => el('span', { class: a.closing_rial < 0 ? 'neg' : 'pos', text: money(a.closing_rial, { unit, withUnit: true }) }) },
              {
                label: '',
                render: (a) =>
                  el('div', { style: 'display:flex;gap:6px' }, [
                    el('button', {
                      class: 'btn sm ghost',
                      text: 'تنظیمات',
                      onclick: async () => {
                        const res = await dialog({
                          title: `ویرایش ${a.name}`,
                          confirmText: 'ذخیره',
                          fields: [
                            { name: 'name', label: 'نام', required: true, placeholder: a.name },
                            { name: 'opening_balance_toman', label: 'موجودی بازگشایی (تومان)', placeholder: String(Math.round(a.opening_balance_rial / 10)) },
                            { name: 'reason', label: 'دلیل تغییر (ثبت در سابقه)', required: true },
                          ],
                        });
                        if (!res?.ok) return;
                        await put(`/api/accounts/${a.id}`, {
                          name: res.values.name,
                          opening_balance_toman: Number(res.values.opening_balance_toman || 0),
                          is_default: true,
                          reason: res.values.reason,
                        });
                        toast('حساب به‌روزرسانی شد.');
                        refresh();
                      },
                    }),
                    a.archived
                      ? null
                      : el('button', {
                          class: 'btn sm danger',
                          text: 'بایگانی',
                          onclick: async () => {
                            const res = await dialog({ title: 'بایگانی حساب', body: 'حساب از لیست‌های جدید حذف می‌شود ولی تراکنش‌های گذشته دست‌نخورده می‌مانند.', confirmText: 'بایگانی', danger: true, fields: [{ name: 'reason', label: 'دلیل *', required: true }] });
                            if (!res?.ok) return;
                            await put(`/api/accounts/${a.id}`, { archived: true, name: a.name, reason: res.values.reason });
                            refresh();
                          },
                        }),
                  ]),
              },
            ],
            accounts.items,
            { empty: 'هنوز حسابی ندارید.' },
          ),
          el('div', { class: 'card-h', style: 'border-top:1px solid var(--line);border-bottom:0;margin-top:10px' }, [el('h3', { text: 'ماندهٔ بازگشایی (قبل از شروع کار با برنامه)' })]),
          el('div', { class: 'card-b', style: 'padding-top:6px' }, [
            el('div', { class: 'notice info' }, ['اگر قبل از استفاده از این برنامه، مشتری بدهکار یا تأمین‌کننده طلبکار داشته‌اید، اینجا وارد کنید. این مبالغ درآمد/هزینه نمی‌شوند، فقط در «طلب و بدهی» دیده می‌شوند.']),
            tableOf(
              [
                { label: 'نوع', render: (o) => (o.kind === 'receivable' ? 'طلب از مشتری' : 'بدهی به تأمین‌کننده') },
                { label: 'طرف حساب' },
                { label: 'مبلغ', num: true, render: (o) => money(o.amount_rial, { unit, withUnit: true }) },
              ],
              financials.opening_balances,
              { empty: 'ماندهٔ بازگشایی ثبت نشده است.' },
            ),
            openingBalanceForm(),
          ]),
        ]),
      ]),
    ]);
  }

  function openingBalanceForm() {
    const kind = Chips({ label: 'نوع', options: [{ value: 'receivable', label: 'طلب از مشتری' }, { value: 'payable', label: 'بدهی به تأمین‌کننده' }], value: 'receivable' });
    const party = TextField({ label: 'نام طرف حساب *' });
    const amount = MoneyField({ label: 'مبلغ *' });
    const btn = el('button', { class: 'btn sm', text: 'ثبت ماندهٔ بازگشایی', type: 'button' });
    btn.addEventListener('click', async () => {
      const a = amount.rial();
      if (!party.value() || !a || Number.isNaN(a)) return toast('نام و مبلغ را وارد کنید.', { type: 'err' });
      try {
        await post('/api/opening-balances', { kind: kind.value, party_name: party.value(), amount_rial: a });
        toast('ثبت شد.');
        refresh();
      } catch (e) {
        toast(e.message, { type: 'err' });
      }
    });
    return el('div', { style: 'margin-top:8px' }, [kind.node, party.node, amount.node, btn]);
  }

  function capitalCard() {
    const date = DateField({});
    const amount = MoneyField({ label: 'مبلغ *' });
    const note = TextField({ label: 'یادداشت' });
    const type = Chips({ label: 'نوع', options: [{ value: 'deposit', label: 'وارسه سرمایه' }, { value: 'withdrawal', label: 'برداشت شخصی' }], value: 'withdrawal' });
    const capBtn = el('button', { class: 'btn', text: 'ثبت', type: 'button' });
    capBtn.addEventListener('click', async () => {
      const a = amount.rial();
      if (!a || Number.isNaN(a)) return toast('مبلغ را وارد کنید.', { type: 'err' });
      try {
        await post('/api/capital', { type: type.value, date: date.date(), amount_rial: a, note: note.value() || undefined, dedupe_key: stickyKey('cap') });
        releaseKey('cap');
        toast('ثبت شد — بر سود اثری ندارد.');
        amount.clear();
        refresh();
      } catch (e) {
        toast(e.message, { type: 'err' });
      }
    });

    const ltype = Chips({
      label: 'نوع تراکنش وام',
      options: [
        { value: 'loan_in', label: 'دریافت وام (اصل)' },
        { value: 'loan_repayment', label: 'پرداخت قسط اصل' },
        { value: 'loan_interest', label: 'بهره / کارمزد' },
      ],
      value: 'loan_in',
    });
    const ldate = DateField({});
    const lamount = MoneyField({ label: 'مبلغ *' });
    const cp = TextField({ label: 'نام وام‌دهنده / بانک' });
    const lnote = TextField({ label: 'یادداشت' });
    const loanBtn = el('button', { class: 'btn', text: 'ثبت وام', type: 'button' });
    loanBtn.addEventListener('click', async () => {
      const a = lamount.rial();
      if (!a || Number.isNaN(a)) return toast('مبلغ را وارد کنید.', { type: 'err' });
      try {
        await post('/api/loans', { type: ltype.value, date: ldate.date(), amount_rial: a, counterparty: cp.value() || undefined, note: lnote.value() || undefined, dedupe_key: stickyKey('loan') });
        releaseKey('loan');
        toast(ltype.value === 'loan_interest' ? 'بهره ثبت شد و سود خالص را کم می‌کند.' : 'ثبت شد — اصل وام هزینه یا درآمد نیست.');
        lamount.clear();
        refresh();
      } catch (e) {
        toast(e.message, { type: 'err' });
      }
    });

    return el('div', { class: 'grid', style: 'gap:12px' }, [
      el('div', { class: 'grid cols-2' }, [
        metric('وارسه سرمایه (این بازه)', financials.capital.reduce((a, x) => a + (x.type === 'deposit' ? x.amount_rial : 0), 0)),
        metric('برداشت شخصی (این بازه)', -financials.capital.reduce((a, x) => a + (x.type === 'withdrawal' ? x.amount_rial : 0), 0)),
        metric('اصل دریافتی وام', financials.loans.reduce((a, x) => a + (x.type === 'loan_in' ? x.amount_rial : 0), 0)),
        metric('بدهی وام باز (کل سابقه)', financials.loans_outstanding, `گردش ${toFa(financials.loans.length)} تراکنش`),
      ]),
      el('div', { class: 'grid cols-2' }, [
        el('section', { class: 'card' }, [
          el('div', { class: 'card-h' }, [el('h2', { text: 'سرمایهٔ شخصی' })]),
          el('div', { class: 'card-b' }, [
            el('div', { class: 'notice info' }, ['برداشت و وارسه فقط نقدیه را تغییر می‌دهد. در «سود» جایی ندارد — حتی اگر برداشت از صندوق فروشگاه باشد.']),
            date.node,
            type.node,
            amount.node,
            note.node,
            capBtn,
          ]),
        ]),
        el('section', { class: 'card' }, [
          el('div', { class: 'card-h' }, [el('h2', { text: 'وام' })]),
          el('div', { class: 'card-b' }, [
            el('div', { class: 'notice info' }, ['اصل وام و اقساط، هزینه نیستند؛ تنها «بهره/کارمزد» به‌عنوان بار مالی از سود کسر می‌شود.']),
            ldate.node,
            ltype.node,
            lamount.node,
            cp.node,
            lnote.node,
            loanBtn,
          ]),
        ]),
      ]),
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'سابقه' })]),
        el('div', { class: 'card-b' }, [
          tableOf(
            [
              { label: 'تاریخ', render: (x) => jalaliText(x.txn_date, { style: 'short' }) },
              { label: 'دسته', render: (x) => el('span', { class: 'badge', text: x.kind }) },
              { label: 'شرح', render: (x) => x.title },
              { label: 'مبلغ', num: true, render: (x) => el('span', { class: x.sign > 0 ? 'pos' : 'neg', text: money(x.sign * x.amount_rial, { unit, withUnit: true }) }) },
              {
                label: '',
                render: (x) =>
                  el('button', {
                    class: 'btn sm danger',
                    text: 'حذف',
                    onclick: async () => {
                      const res = await dialog({ title: 'حذف تراکنش', confirmText: 'حذف', danger: true, fields: [{ name: 'reason', label: 'دلیل *', required: true }] });
                      if (!res?.ok) return;
                      await del(`/api/${x.kind === 'capital' ? 'capital' : 'loans'}/${x.id}`, { reason: res.values.reason });
                      refresh();
                    },
                  }),
              },
            ],
            [
              ...financials.capital.map((c) => ({ id: c.id, txn_date: c.txn_date, kind: 'capital', title: c.type === 'deposit' ? 'وارسه سرمایه' : 'برداشت سرمایه', amount_rial: c.amount_rial, sign: c.type === 'deposit' ? 1 : -1, _t: 'capital' })),
              ...financials.loans.map((l) => ({
                id: l.id,
                txn_date: l.txn_date,
                kind: 'loan',
                title: `${{ loan_in: 'دریافت وام', loan_repayment: 'قسط اصل وام', loan_interest: 'بهره/کارمزد' }[l.type]}${l.counterparty ? ` — ${l.counterparty}` : ''}`,
                amount_rial: l.amount_rial,
                sign: l.type === 'loan_in' ? 1 : -1,
                _t: 'loans',
              })),
            ].sort((a, b) => (a.txn_date < b.txn_date ? 1 : -1)),
            { empty: 'تراکنشی در این بازه نیست.' },
          ),
        ]),
      ]),
    ]);
  }

  function metric(label, rial, foot = null) {
    return el('div', { class: `metric ${rial < 0 ? 'neg' : ''}` }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: money(rial, { unit, withUnit: true }) }), foot ? el('div', { class: 'foot', text: foot }) : null]);
  }
}
