// خرید و موجودی — purchase entry (with acquisition costs), inventory valuation
// and stock adjustments (write-off / count surplus).
import { el, clear, money, qty, toFa, toast, dialog, jalaliText, parseNum } from '../util.js';
import { MoneyField, QtyField, Chips, TextField, ProductPicker, DateField, tableOf, displayUnit } from '../components.js';
import { get, post, put, stickyKey, releaseKey } from '../api.js';
import { state as appState } from '../app.js';

export async function render(host, { params, refresh }) {
  clear(host);
  const productsData = await get('/api/products?include_inactive=1');
  const products = productsData.items;
  const tabs = ['ثبت خرید', 'موجودی و کالاها', 'تعدیلات موجودی', 'لیست خرید'];
  let active = params.get('tab') === 'inventory' ? 1 : params.get('tab') === 'adjust' ? 2 : params.get('new') === '1' ? 0 : 0;
  const body = el('div');
  const bar = el('div', { class: 'chips' });
  tabs.forEach((t, i) =>
    bar.appendChild(
      el('button', {
        class: 'chip',
        type: 'button',
        text: t,
        'aria-pressed': String(i === active),
        onclick: () => {
          active = i;
          [...bar.children].forEach((c, j) => c.setAttribute('aria-pressed', String(j === i)));
          paint();
        },
      }),
    ),
  );
  host.appendChild(el('div', { class: 'grid', style: 'gap:12px' }, [bar, body]));
  paint();

  function paint() {
    clear(body);
    if (active === 0) body.appendChild(purchaseForm(products, refresh));
    if (active === 1) body.appendChild(inventoryCard(products, refresh));
    if (active === 2) body.appendChild(adjustCard(products, refresh));
    if (active === 3) body.appendChild(purchasesList(refresh));
  }
}

/* ------------------------------------------------------- purchase entry --- */
function purchaseForm(products, refresh) {
  const lines = [];
  const date = DateField({});
  const supplier = TextField({ label: 'نام تأمین‌کننده', placeholder: 'مثلاً بازرگانی امید' });
  const phone = TextField({ label: 'تلفن تأمین‌کننده (اختیاری)' });
  const picker = ProductPicker({
    label: 'کالای خریداری‌شده',
    products: [...products],
    onPick: (p) => {
      current = p;
      // prefill with the current weighted-average cost so a repeat purchase is one tap
      if (!cost.rial()) cost.set(p.avg_unit_cost_rial || 0);
      renderLines();
    },
    onCreate: async (name) => {
      const out = await post('/api/products', { name, kind: 'goods', unit: 'عدد' });
      products.push(out.item);
      toast('کالای جدید ساخته شد.');
      return out.item;
    },
  });
  let current = null;
  const qtyNode = QtyField({ label: 'مقدار خرید', value: 1 });
  const cost = MoneyField({ label: 'بهای تمام‌شدهٔ هر واحد *', onInput: renderTotals });
  const extra = MoneyField({ label: 'هزینه‌های جانبی (حمل، باربری، بیمه…)', value: 0, onInput: renderTotals });
  const extraNote = TextField({ label: 'شرح هزینه جانبی', placeholder: 'مثلاً کرایه بار' });
  const method = Chips({
    label: 'روش پرداخت *',
    options: [
      { value: 'cash', label: '💵 نقدی' },
      { value: 'card', label: '💳 کارت' },
      { value: 'transfer', label: '🏦 انتقال بانکی' },
      { value: 'credit', label: '📝 نسیه (پرداخت بعدی)' },
      { value: 'other', label: 'سایر' },
    ],
    value: 'cash',
    onChange: () => {
      if (method.value === 'credit') paid.set(0);
      else renderTotals();
    },
  });
  const paid = MoneyField({ label: 'پرداخت‌شده', onInput: renderTotals });
  const note = TextField({ label: 'یادداشت', multiline: true });
  const linesHost = el('div', { class: 'row-list' });
  const totalsBox = el('div');
  const addBtn = el('button', { class: 'btn subtle', type: 'button', text: '＋ افزودن ردیف' });
  const saveBtn = el('button', { class: 'btn', type: 'button', text: 'ثبت خرید و افزودن به موجودی' });
  addBtn.addEventListener('click', () => {
    const l = readLine();
    if (!l) return toast('کالا، مقدار و بهای واحد را کامل وارد کنید.', { type: 'err' });
    lines.push(l);
    qtyNode.set(1);
    cost.clear();
    renderLines();
  });
  saveBtn.addEventListener('click', () => save());

  const node = el('section', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h2', { text: 'ثبت خرید' }), el('span', { class: 'spacer' }), el('span', { class: 'badge info', text: 'خرید تا زمان فروش، هزینه نمی‌شود' })]),
    el('div', { class: 'card-b' }, [
      date.node,
      el('div', { class: 'grid cols-2' }, [supplier.node, phone.node]),
      picker.node,
      el('div', { class: 'grid cols-2' }, [qtyNode.node, cost.node]),
      linesHost,
      totalsBox,
      el('details', {}, [
        el('summary', { style: 'font-weight:700;font-size:13px;cursor:pointer', text: 'هزینه جانبی، روش پرداخت و یادداشت' }),
        el('div', { style: 'padding-top:10px' }, [extra.node, extraNote.node, method.node, paid.node, note.node]),
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:8px' }, [addBtn, saveBtn]),
    ]),
  ]);

  function readLine() {
    if (!current) return null;
    const q = qtyNode.qty();
    const c = cost.rial();
    if (!q || Number.isNaN(q) || c === null || Number.isNaN(c)) return null;
    return { product_id: current.id, product_name: current.name, qty_x1000: q, unit_cost_rial: c, line_total_rial: Math.round((q * c) / 1000) };
  }
  function renderLines() {
    linesHost.replaceChildren();
    lines.forEach((l, i) =>
      linesHost.appendChild(
        el('div', { class: 'line-row' }, [
          el('div', {}, [el('div', { class: 'name', text: l.product_name }), el('div', { class: 'meta', text: `${qty(l.qty_x1000)} × ${money(l.unit_cost_rial, { withUnit: true })}` })]),
          el('div', { style: 'text-align:end' }, [
            el('div', { class: 'amt', text: money(l.line_total_rial, { withUnit: true }) }),
            el('button', { class: 'btn sm danger', style: 'margin-top:4px', text: 'حذف', onclick: () => { lines.splice(i, 1); renderLines(); } }),
          ]),
        ]),
      ),
    );
    renderTotals();
  }
  function renderTotals() {
    const goods = lines.reduce((a, l) => a + l.line_total_rial, 0);
    const ex = extra.rial();
    const total = goods + (ex && !Number.isNaN(ex) ? ex : 0);
    if (method.value !== 'credit') paid.set(total);
    totalsBox.replaceChildren(
      el('div', { class: 'total-bar', style: 'position:static;margin:10px 0' }, [
        el('div', {}, [el('div', { class: 'k', text: 'کل مبلغ خرید (با هزینه جانبی)' }), el('div', { class: 'v', text: money(total, { withUnit: true }) })]),
        el('div', { style: 'text-align:end' }, [el('div', { class: 'k', text: 'مانده به تأمین‌کننده' }), el('div', { class: 'v', style: 'font-size:15px', text: money(Math.max(0, total - (paid.rial() || 0)), { withUnit: true }) })]),
      ]),
    );
  }
  async function save() {
    let payload = lines;
    const pending = readLine();
    if (!payload.length && pending) payload = [pending];
    if (!payload.length) return toast('حداقل یک ردیف کالا لازم است.', { type: 'err' });
    if (pending && payload === lines) payload = [...lines, pending];
    const ex = extra.rial();
    const body = {
      purchase_date: date.date(),
      supplier_name: supplier.value() || undefined,
      supplier_phone: phone.value() || undefined,
      payment_method: method.value,
      lines: payload.map((l) => ({ product_id: l.product_id, qty: String(l.qty_x1000 / 1000), unit_cost_rial: l.unit_cost_rial })),
      extra_cost_rial: ex && !Number.isNaN(ex) ? ex : undefined,
      extra_cost_note: extraNote.value() || undefined,
      paid_rial: paid.rial() || 0,
      note: note.value() || undefined,
      dedupe_key: stickyKey('purchase'),
    };
    saveBtn.disabled = true;
    try {
      const out = await post('/api/purchases', body);
      releaseKey('purchase');
      toast(out.message || 'خرید ثبت شد.');
      lines.length = 0;
      renderLines();
      await refresh();
    } catch (e) {
      toast(e.message, { type: 'err', timeout: 6000 });
    } finally {
      saveBtn.disabled = false;
    }
  }
  renderLines();
  return node;
}

/* ------------------------------------------------------------ inventory --- */
function inventoryCard(products, refresh) {
  const unit = displayUnit();
  const totalValue = products.reduce((a, p) => a + p.stock_cost_rial, 0);
  const negative = products.filter((p) => p.stock_qty_x1000 < 0);
  const table = tableOf(
    [
      { label: 'کالا/خدمت', render: (p) => el('div', {}, [el('b', { text: p.name }), el('div', { class: 'hint', style: 'margin:0', text: [p.sku, p.kind === 'service' ? 'خدمت' : 'کالا'].filter(Boolean).join(' · ') })]) },
      {
        label: 'موجودی',
        num: true,
        render: (p) => el('span', { class: p.stock_qty_x1000 < 0 ? 'neg' : '', text: qty(p.stock_qty_x1000, { unit: p.unit }) }),
      },
      { label: 'میانگین بها', num: true, render: (p) => money(p.avg_unit_cost_rial || 0, { unit, withUnit: true }) },
      { label: 'ارزش موجودی', num: true, render: (p) => money(p.stock_cost_rial, { unit, withUnit: true }) },
      { label: 'هزینهٔ جایگزینی واحد', num: true, render: (p) => (p.replacement_unit_cost_rial ? money(p.replacement_unit_cost_rial, { unit, withUnit: true }) : '—') },
      {
        label: '',
        render: (p) =>
          el('button', {
            class: 'btn sm ghost',
            text: 'ویرایش',
            onclick: async () => {
              const res = await dialog({
                title: `ویرایش ${p.name}`,
                confirmText: 'ذخیره',
                fields: [
                  { name: 'sku', label: 'کد کالا (SKU)', placeholder: p.sku || '' },
                  { name: 'replacement_cost_toman', label: 'هزینهٔ جایگزینی هر واحد (تومان) — برای تحلیل تورم', placeholder: p.replacement_unit_cost_rial ? String(Math.round(p.replacement_unit_cost_rial / 10)) : '' },
                  { name: 'unit', label: 'واحد', placeholder: p.unit },
                  { name: 'opening_qty', label: 'موجودی بازگشایی (اختیاری)', placeholder: p.opening_qty_x1000 ? String(p.opening_qty_x1000 / 1000) : '', hint: 'مقداری که پیش از شروع کار با برنامه در انبار داشتید؛ فروش یا هزینه نیست.' },
                  { name: 'opening_unit_cost', label: 'بهای هر واحد در شروع (تومان)', placeholder: p.opening_qty_x1000 ? String(Math.round(p.opening_cost_rial / (10 * p.opening_qty_x1000))) : '' },
                  { name: 'reason', label: 'دلیل تغییر' },
                ],
              });
              if (!res?.ok) return;
              const body = { sku: res.values.sku || null, unit: res.values.unit || p.unit, reason: res.values.reason || undefined };
              const rc = parseNum(res.values.replacement_cost_toman);
              if (!Number.isNaN(rc) && rc > 0) body.replacement_cost_toman = rc;
              const oq = parseNum(res.values.opening_qty);
              const ouc = parseNum(res.values.opening_unit_cost);
              if (!Number.isNaN(oq) && oq > 0) {
                body.opening_qty = oq;
                if (!Number.isNaN(ouc) && ouc > 0) body.opening_unit_cost_toman = ouc;
              } else if (p.opening_qty_x1000 && String(res.values.opening_qty ?? '') === '0') {
                body.opening_qty = 0;
              }
              await put(`/api/products/${p.id}`, body);
              toast('تغییرات ذخیره شد. اگر «هزینهٔ جایگزینی» را وارد کردید، در بخش سود واقعی اعمال می‌شود.');
              refresh();
            },
          }),
      },
    ],
    [...products].sort((a, b) => b.stock_cost_rial - a.stock_cost_rial),
    { empty: 'هنوز کالایی ثبت نشده است. با «ثبت خرید» شروع کنید.', cls: 'table-compact' },
  );
  return el('div', { class: 'grid', style: 'gap:12px' }, [
    el('div', { class: 'grid cols-3' }, [
      el('div', { class: 'metric' }, [el('div', { class: 'label', text: 'ارزش کل موجودی (بهای تمام‌شده)' }), el('div', { class: 'value', text: money(totalValue, { unit, withUnit: true }) })]),
      el('div', { class: 'metric' }, [el('div', { class: 'label', text: 'تعداد اقلام' }), el('div', { class: 'value', text: toFa(products.length) })]),
      el('div', { class: `metric ${negative.length ? 'neg' : ''}` }, [el('div', { class: 'label', text: 'موجودی منفی' }), el('div', { class: 'value', text: toFa(negative.length) })]),
    ]),
    negative.length ? el('div', { class: 'notice bad' }, [`این اقلام موجودی منفی دارند و تا اصلاح، گزارش نهایی صادر نمی‌شود: ${negative.map((p) => `${p.name} (${qty(p.stock_qty_x1000)})`).join('، ')}`]) : null,
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'موجودی و کالاها' }), el('span', { class: 'spacer' }), el('a', { class: 'btn sm ghost', href: '/api/export.csv?table=inventory', download: true, text: 'CSV' })]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'notice info' }, ['ارزش موجودی بر پایهٔ میانگین موزونِ بهای تمام‌شده محاسبه می‌شود؛ «هزینهٔ جایگزینی» را جداگانه وارد کنید تا برآورد سودِ جایگزینی فعال شود.']),
        table,
      ]),
    ]),
  ]);
}

/* --------------------------------------------------------- adjustments --- */
function adjustCard(products, refresh) {
  const date = DateField({});
  const pick = SelectField({ label: 'کالا *', options: [{ value: '', label: 'انتخاب کنید…' }, ...products.map((p) => ({ value: p.id, label: `${p.name} (${qty(p.stock_qty_x1000, { unit: p.unit })})` }))], value: '' });
  const dir = Chips({ label: 'نوع تعدیل', options: [{ value: '-1', label: 'کسر (اسقاط/کسری/آسیب)' }, { value: '1', label: 'اضافه (اضافه انبار)' }], value: '-1' });
  const q = QtyField({ label: 'مقدار', value: 1 });
  const cost = MoneyField({ label: 'بهای واحد (اختیاری — پیش‌فرض: میانگین موزون)' });
  const reason = SelectField({
    label: 'دلیل *',
    options: Object.entries(appState.adjustmentReasons || {}).map(([value, label]) => ({ value, label })),
    value: 'shrinkage',
  });
  const note = TextField({ label: 'یادداشت', multiline: true });
  const save = el('button', { class: 'btn', text: 'ثبت تعدیل', type: 'button' });
  save.addEventListener('click', async () => {
    const product = products.find((p) => String(p.id) === String(pick.value()));
    if (!product) return toast('کالا را انتخاب کنید.', { type: 'err' });
    const amount = q.qty();
    if (!amount || Number.isNaN(amount)) return toast('مقدار را وارد کنید.', { type: 'err' });
    const delta = Number(dir.value) * amount;
    save.disabled = true;
    try {
      const body = { date: date.date(), product_id: product.id, delta_qty: String(delta / 1000), reason: reason.value(), note: note.value() || undefined, dedupe_key: stickyKey('adj') };
      const c = cost.rial();
      if (c && !Number.isNaN(c)) body.unit_cost_rial = c;
      await post('/api/inventory/adjustments', body);
      releaseKey('adj');
      toast('تعدیل موجودی ثبت شد و در سود دوره اعمال گردید.');
      await refresh();
    } catch (e) {
      toast(e.message, { type: 'err', timeout: 6000 });
    } finally {
      save.disabled = false;
    }
  });
  const host = el('div', { class: 'grid cols-2' }, [
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'تعدیل موجودی (اسقاط / اضافه انبار)' })]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'notice info' }, ['کالا تنها با «فروش» یا «تعدیل» از موجودی خارج می‌شود. هزینهٔ اسقاط در همین دوره به عنوان کاهش سود ثبت می‌شود.']),
        date.node,
        pick.node,
        dir.node,
        el('div', { class: 'grid cols-2' }, [q.node, cost.node]),
        reason.node,
        note.node,
        save,
      ]),
    ]),
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'سابقهٔ تعدیلات' })]),
      el('div', { class: 'card-b', id: 'adj-list' }, [el('div', { class: 'notice info', text: 'در حال خواندن…' })]),
    ]),
  ]);
  get('/api/inventory/adjustments?range=all')
    .then((data) => {
      host.querySelector('#adj-list').replaceChildren(
        tableOf(
          [
            { label: 'تاریخ', render: (a) => jalaliText(a.txn_date, { style: 'short' }) },
            { label: 'کالا', render: (a) => a.product_name },
            { label: 'مقدار', num: true, render: (a) => (a.delta_qty_x1000 < 0 ? '−' : '+') + qty(Math.abs(a.delta_qty_x1000)) },
            { label: 'اثر در سود', num: true, render: (a) => money(-a.cost_impact_rial, { withUnit: true }) },
            { label: 'دلیل', render: (a) => (appState.adjustmentReasons || {})[a.reason] || a.reason },
          ],
          data.items,
          { empty: 'تعدیلی ثبت نشده است.', cls: 'table-compact' },
        ),
      );
    })
    .catch((e) => host.querySelector('#adj-list').replaceChildren(el('div', { class: 'notice bad', text: e.message })));
  return host;
}

/* ------------------------------------------------------- purchases list --- */
function purchasesList(refresh) {
  const host = el('section', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h2', { text: 'لیست خریدها' })]),
    el('div', { class: 'card-b' }, [el('div', { class: 'notice info', text: 'در حال خواندن…' })]),
  ]);
  load();
  async function load() {
    const r = appState.range || { mode: 'month' };
    const q = r.mode === 'custom' && r.from && r.to ? `from=${r.from}&to=${r.to}` : `range=${r.mode || 'month'}`;
    const data = await get(`/api/purchases?${q}`);
    host.querySelector('.card-b').replaceChildren(
      tableOf(
        [
          { label: 'تاریخ', render: (p) => jalaliText(p.purchase_date, { style: 'short' }) },
          { label: 'تأمین‌کننده', render: (p) => p.supplier_name || '—' },
          { label: 'کل', num: true, render: (p) => money(p.total_rial, { withUnit: true }) },
          { label: 'پرداخت‌شده', num: true, render: (p) => money(p.amount_paid_rial, { withUnit: true }) },
          {
            label: 'مانده',
            num: true,
            render: (p) =>
              p.outstanding_rial > 0
                ? el('span', { class: 'neg', text: money(p.outstanding_rial, { withUnit: true }) })
                : el('span', { class: 'badge ok', text: 'تسویه' }),
          },
        ],
        data.items,
        { empty: 'در این بازه خریدی ثبت نشده است.' },
      ),
    );
  }
  return host;
}
