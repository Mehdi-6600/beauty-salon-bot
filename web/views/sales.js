// ثبت فروش — fast invoice entry (a few taps), the sales ledger, per-invoice
// detail with returns and collections.
import { el, clear, money, qty, toFa, toast, dialog, jalaliText, dateTimeLabel, parseNum } from '../util.js';
import { MoneyField, QtyField, Chips, TextField, ProductPicker, DateField, tableOf, displayUnit } from '../components.js';
import { get, post, put, del, stickyKey, releaseKey } from '../api.js';
import { state as appState } from '../app.js';

let productsCache = null;

export async function render(host, { params, refresh }) {
  clear(host);
  const id = params.get('id');
  if (id) return renderDetail(host, Number(id), refresh);
  const wrap = el('div', { class: 'grid', style: 'gap:12px' });
  const tabs = el('div', { class: 'chips' }, [
    tab('ثبت فروش', true),
    tab('لیست فروش', false),
  ]);
  function tab(label, active) {
    return el('button', {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(active),
      text: label,
      onclick: (e) => {
        for (const c of tabs.children) c.setAttribute('aria-pressed', 'false');
        e.currentTarget.setAttribute('aria-pressed', 'true');
        body.replaceChildren(label === 'ثبت فروش' ? formCard() : listCard());
      },
    });
  }
  const body = el('div');
  wrap.appendChild(tabs);
  wrap.appendChild(body);
  host.appendChild(wrap);

  const products = productsCache || (productsCache = (await get('/api/products?include_inactive=0')).items);
  const formCard = () => entryForm(products, { onSaved: async () => { productsCache = null; await refresh(); } });
  const listCard = () => salesList(refresh);

  body.appendChild(params.get('new') === '1' || !params.get('tab') ? formCard() : listCard());
}

/* ------------------------------------------------------------- entry form -- */
function entryForm(products, { onSaved, existing = null, onCancelled }) {
  const lines = [];
  const date = DateField({});
  const picker = ProductPicker({
    products: [...products],
    onPick: (p) => {
      currentProduct = p;
      // remember the last selling price for this item so repeat sales need no typing
      if (!priceTouched && p.last_price_rial) price.set(p.last_price_rial);
      qtyNode.input.focus();
      renderLines();
    },
    onCreate: async (name) => {
      const out = await post('/api/products', { name, kind: 'goods', unit: 'عدد' });
      toast('کالا ساخته شد.');
      products.push(out.item);
      picker.node.querySelectorAll('.row-list')[0]?.replaceChildren();
      return out.item;
    },
  });
  let currentProduct = null;
  const qtyNode = QtyField({ value: 1, unitName: 'عدد' });
  let priceTouched = false;
  const price = MoneyField({ label: 'قیمت فروش هر واحد *', onInput: () => { priceTouched = true; renderTotals(); } });
  const lineDisc = MoneyField({ label: 'تخفیف این ردیف', value: 0 });
  const headDisc = MoneyField({ label: 'تخفیف کل فاکتور', value: 0 });
  const method = Chips({
    label: 'روش پرداخت *',
    options: [
      { value: 'cash', label: '💵 نقدی' },
      { value: 'card', label: '💳 کارت' },
      { value: 'transfer', label: '🏦 انتقال بانکی' },
      { value: 'credit', label: '📝 نسیه' },
      { value: 'other', label: 'سایر' },
    ],
    value: existing?.payment_method || 'cash',
    onChange: () => syncReceived(),
  });
  const received = MoneyField({ label: 'دریافت‌شده', onInput: () => { receivedTouched = true; renderTotals(); } });
  let receivedTouched = !!existing;
  const customer = TextField({ label: 'نام مشتری (اختیاری)', value: existing?.customer_name || '', placeholder: 'مثلاً آقای رضایی' });
  const phone = TextField({ label: 'شماره تماس (اختیاری)', placeholder: '۰۹۱۲…' });
  const note = TextField({ label: 'یادداشت', multiline: true, value: existing?.note || '' });
  const more = el('details', {}, [el('summary', { style: 'font-weight:700;font-size:13px;cursor:pointer', text: 'جزئیات بیشتر (تخفیف ردیف، یادداشت، مشتری)' })]);

  const linesHost = el('div', { class: 'row-list' });
  const totalsBox = el('div', {});
  const saveBtn = el('button', { class: 'btn', text: existing ? 'ذخیرهٔ تغییرات' : 'ثبت فروش', type: 'button' });
  const addBtn = el('button', { class: 'btn subtle', type: 'button', text: '＋ افزودن ردیف به فاکتور' });

  const node = el('section', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h2', { text: existing ? 'ویرایش فاکتور فروش' : 'ثبت فروش' }), el('span', { class: 'spacer' }), el('span', { class: 'badge', text: 'واحد: تومان یا ریال' })]),
    el('div', { class: 'card-b' }, [
      date.node,
      picker.node,
      el('div', { class: 'grid cols-2' }, [qtyNode.node, price.node]),
      linesHost,
      totalsBox,
      headDisc.node,
      method.node,
      received.node,
      el('div', { class: 'btn-row', style: 'margin-top:6px' }, [addBtn, saveBtn, existing ? null : el('button', { class: 'btn ghost', text: 'پاک کردن فرم', onclick: () => location.reload() })]),
    ]),
  ]);

  addBtn.addEventListener('click', () => addLine());
  saveBtn.addEventListener('click', () => save());

  function currentLine() {
    if (!currentProduct) return null;
    const q = qtyNode.qty();
    const p = price.rial();
    if (!q || Number.isNaN(q) || q <= 0) return null;
    if (p === null || Number.isNaN(p)) return null;
    const d = lineDisc.rial();
    return {
      product_id: currentProduct.id,
      description: currentProduct.name,
      qty_x1000: q,
      unit_price_rial: p,
      discount_rial: d && !Number.isNaN(d) ? d : 0,
      line_total_rial: Math.round((q * p) / 1000),
      kind: 'sale',
    };
  }

  function addLine() {
    const l = currentLine();
    if (!l) return toast('ابتدا کالا، تعداد و قیمت واحد را کامل کنید.', { type: 'err' });
    lines.push(l);
    // the added line is now owned by the invoice — reset the draft row so it
    // cannot be submitted twice
    currentProduct = null;
    picker.set(null);
    price.clear();
    lineDisc.clear();
    qtyNode.set(1);
    renderLines();
    picker.node.querySelector('input')?.focus();
  }

  function renderLines() {
    linesHost.replaceChildren();
    lines.forEach((l, i) => {
      linesHost.appendChild(
        el('div', { class: 'line-row' }, [
          el('div', {}, [
            el('div', { class: 'name', text: l.description }),
            el('div', { class: 'meta', text: `${qty(l.qty_x1000)} × ${money(l.unit_price_rial, { withUnit: true })}${l.discount_rial ? ` − تخفیف ${money(l.discount_rial, { withUnit: true })}` : ''}` }),
          ]),
          el('div', { style: 'text-align:end' }, [
            el('div', { class: 'amt', text: money(l.line_total_rial - l.discount_rial, { withUnit: true }) }),
            el('button', {
              class: 'btn sm danger',
              style: 'margin-top:4px',
              text: 'حذف',
              onclick: () => {
                lines.splice(i, 1);
                renderLines();
              },
            }),
          ]),
        ]),
      );
    });
    renderTotals();
  }

  function totals() {
    const gross = lines.reduce((a, l) => a + l.line_total_rial, 0);
    const lineDisc2 = lines.reduce((a, l) => a + (l.discount_rial || 0), 0);
    const hd = headDisc.rial();
    const h = hd && !Number.isNaN(hd) ? hd : 0;
    const net = Math.max(0, gross - lineDisc2 - h);
    return { gross, lineDisc: lineDisc2, head: h, net };
  }

  function renderTotals() {
    const tt = totals();
    if (!receivedTouched) received.set(tt.net);
    totalsBox.replaceChildren(
      el('div', { class: 'total-bar', style: 'position:static;margin:10px 0' }, [
        el('div', {}, [el('div', { class: 'k', text: 'کل فاکتور' }), el('div', { class: 'v', text: money(tt.net, { unit: displayUnit(), withUnit: true }) })]),
        el('div', { style: 'text-align:end' }, [
          el('div', { class: 'k', text: 'ماندهٔ پرداخت' }),
          el('div', { class: 'v', style: 'font-size:15px', text: money(Math.max(0, tt.net - (received.rial() || 0)), { unit: displayUnit(), withUnit: true }) }),
        ]),
      ]),
    );
  }

  function syncReceived() {
    if (method.value === 'credit') {
      receivedTouched = false;
      received.set(0);
      receivedTouched = false;
    } else renderTotals();
  }

  async function save() {
    let payloadLines = lines;
    const pending = currentLine();
    if (!payloadLines.length && pending) payloadLines = [pending];
    if (!payloadLines.length) return toast('حداقل یک ردیف (کالا، تعداد، قیمت) لازم است.', { type: 'err' });
    if (currentProduct && pending && payloadLines === lines) {
      // the operator left a finished line on the form: include it
      payloadLines = [...lines, pending];
    }
    const hd = headDisc.rial();
    const body = {
      date: date.date(),
      time: date.time(),
      payment_method: method.value,
      received_rial: received.rial() || 0,
      discount_rial: hd && !Number.isNaN(hd) ? hd : 0,
      customer_name: customer.value() || undefined,
      customer_phone: phone.value() || undefined,
      note: note.value() || undefined,
      lines: payloadLines.map((l) => ({
        id: l.id ?? undefined,
        product_id: l.product_id,
        description: l.description,
        kind: l.kind,
        qty: (l.qty_x1000 / 1000).toString(),
        unit_price_rial: l.unit_price_rial,
        discount_rial: l.discount_rial,
        origin_line_id: l.origin_line_id || undefined,
      })),
    };
    saveBtn.disabled = true;
    try {
      if (existing) {
        const reason = await dialog({ title: 'دلیل ویرایش فاکتور', body: 'ویرایش فاکتور در «سابقهٔ تغییرات» ثبت می‌شود و گزارش‌های این دوره بازمحاسبه می‌گردد.', confirmText: 'ثبت تغییرات', fields: [{ name: 'reason', label: 'دلیل ویرایش *', required: true, multiline: true, placeholder: 'مثلاً اشتباه در تعداد' }] });
        if (!reason || !reason.ok) return;
        body.reason = reason.values.reason;
        await put(`/api/sales/${existing.id}`, body);
        toast('فاکتور به‌روزرسانی شد.');
      } else {
        body.dedupe_key = stickyKey('sale');
        const out = await post('/api/sales', body);
        toast(out.message || 'فروش ثبت شد.');
        releaseKey('sale');
        lines.length = 0;
        qtyNode.set(1);
        price.clear();
        lineDisc.clear();
        headDisc.clear();
        receivedTouched = false;
        renderLines();
        picker.node.querySelector('input')?.focus();
        picker.set(null);
        currentProduct = null;
      }
      productsCache = null;
      if (onSaved) await onSaved();
      else if (onCancelled) onCancelled();
    } catch (e) {
      const hint = e.details?.existing_id ? ' اگر واقعاً فروش تکراری نیست، یک‌بار فرم را تغییر دهید.' : '';
      toast(`${e.message}${hint}`, { type: 'err', timeout: 6000 });
    } finally {
      saveBtn.disabled = false;
    }
  }

  renderLines();
  if (existing) {
    for (const l of existing.lines) lines.push({ ...l, description: l.description });
    if (existing.customer_name) customer.input.value = existing.customer_name;
    headDisc.set(existing.header_discount_rial || 0);
    received.set(existing.amount_received_rial || 0);
    renderLines();
  }
  return node;
}

/* ------------------------------------------------------------------ list -- */
function salesList(refresh) {
  const host = el('section', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h2', { text: 'لیست فروش' }), el('span', { class: 'spacer' }), el('a', { class: 'btn sm ghost', href: `/api/export.csv?table=sales&${periodQuery()}`, download: true, text: 'خروجی CSV' })]),
    el('div', { class: 'card-b' }, [el('div', { class: 'notice info', text: 'در حال خواندن…' })]),
  ]);
  load().catch((e) => toast(e.message, { type: 'err' }));
  async function load() {
    const data = await get(`/api/sales?${periodQuery()}&limit=120`);
    host.querySelector('.card-b').replaceChildren(
      el('div', { class: 'grid', style: 'gap:10px' }, [
        el('div', { class: 'grid cols-2' }, [
          miniMetric('فروش خالص', data.totals.net_rial),
          miniMetric('تعداد فاکتور', toFa(data.totals.invoices), true),
        ]),
        tableOf(
          [
            { label: 'تاریخ', render: (r) => el('span', { text: `${jalaliText(r.txn_date, { style: 'short' })}${(r.occurred_at || '').slice(11, 16) ? ` ${toFa(r.occurred_at.slice(11, 16))}` : ''}` }) },
            { label: 'مشتری' },
            { label: 'کل', num: true, render: (r) => money(r.total_rial, { withUnit: true }) },
            {
              label: 'مانده',
              num: true,
              render: (r) =>
                r.outstanding_rial > 0 ? el('span', { class: 'neg', text: money(r.outstanding_rial, { withUnit: true }) }) : el('span', { class: 'badge ok', text: 'تسویه' }),
            },
            {
              label: '',
              render: (r) =>
                el('button', {
                  class: 'btn sm ghost',
                  text: 'جزئیات',
                  onclick: () => {
                    location.hash = `#/sales?id=${r.id}`;
                  },
                }),
            },
          ],
          data.items.map((r) => ({ ...r, customer_name: r.customer_name || 'بدون نام' })),
          { empty: 'در این بازه فروشی ثبت نشده است. از «ثبت فروش» شروع کنید.' },
        ),
      ]),
    );
  }
  return host;
}

const miniMetric = (label, rial, plain = false) =>
  el('div', { class: 'metric' }, [el('div', { class: 'label', text: label }), el('div', { class: 'value', text: plain ? String(rial) : money(rial, { withUnit: true }) })]);

function periodQuery() {
  const r = appState.range || { mode: 'month' };
  if (r.mode === 'custom' && r.from && r.to) return `from=${r.from}&to=${r.to}`;
  return `range=${r.mode || 'month'}`;
}

/* ---------------------------------------------------------------- detail -- */
async function renderDetail(host, id, refresh) {
  const box = el('div', { class: 'grid', style: 'gap:12px' });
  host.appendChild(box);
  const sale = await get(`/api/sales/${id}`);
  const unit = displayUnit();
  const c = sale.computed;
  box.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-h' }, [
        el('h2', { text: `فاکتور فروش ${toFa(id)}` }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn sm ghost', text: 'بازگشت', onclick: () => { location.hash = '#/sales'; } }),
      ]),
      el('div', { class: 'card-b grid' }, [
        el('div', { class: 'notice' }, [
          el('b', { text: dateTimeLabel(sale.occurred_at) }),
          ` · مشتری: ${sale.customer_name || 'بدون نام'} · روش: ${methodLabel(sale.payment_method)}`,
          sale.note ? ` · یادداشت: ${sale.note}` : '',
        ]),
        el('div', { class: 'grid cols-2' }, [
          miniMetric('فروش ناخالص', c.gross_rial),
          miniMetric('تخفیف‌ها', -c.discounts_rial),
          miniMetric('مرجوعی', -c.returns_rial),
          miniMetric('کل فاکتور', c.total_rial),
          miniMetric('دریافت‌شده', c.received_rial),
          miniMetric('مانده', c.outstanding_rial),
        ]),
        tableOf(
          [
            { label: 'ردیف', render: (l) => el('span', { text: `${toFa(l.id)} ${l.kind === 'return' ? '(مرجوعی)' : ''}` }) },
            { label: 'کالا/خدمت', render: (l) => el('b', { text: l.description }) },
            { label: 'تعداد', num: true, render: (l) => qty(l.qty_x1000) },
            { label: 'قیمت واحد', num: true, render: (l) => money(l.unit_price_rial, { unit, withUnit: true }) },
            { label: 'مبلغ', num: true, render: (l) => money(l.line_total_rial - l.discount_rial, { unit, withUnit: true }) },
            { label: 'بهای تمام‌شده ثبت‌شده', num: true, render: (l) => money(l.cogs_rial, { unit, withUnit: true }) },
          ],
          sale.lines,
        ),
        sale.settlements.length
          ? tableOf(
              [
                { label: 'تاریخ', render: (s) => jalaliText(s.txn_date, { style: 'short' }) },
                { label: 'مبلغ', num: true, render: (s) => money(s.amount_rial, { unit, withUnit: true }) },
                { label: 'روش' },
                {
                  label: '',
                  render: (s) =>
                    el('button', {
                      class: 'btn sm danger',
                      text: 'حذف',
                      onclick: async () => {
                        const ok = await dialog({ title: 'حذف وصول مطالبات', body: 'این وصول حذف می‌شود و ماندهٔ فاکتور و گزارش‌های دوره بازمحاسبه می‌گردد.', confirmText: 'حذف', danger: true, fields: [{ name: 'reason', label: 'دلیل *', required: true }] });
                        if (!ok?.ok) return;
                        await del(`/api/settlements/${s.id}`, { reason: ok.values.reason });
                        toast('وصول حذف شد.');
                        refresh();
                      },
                    }),
                },
              ],
              sale.settlements,
              { cls: 'table-compact' },
            )
          : null,
        el('div', { class: 'btn-row' }, [
          c.outstanding_rial > 0
            ? el('button', { class: 'btn', text: 'ثبت وصول مطالبات', onclick: () => receipt(sale, refresh) })
            : null,
          sale.lines.some((l) => l.kind === 'sale')
            ? el('button', { class: 'btn subtle', text: 'ثبت مرجوعی از این فاکتور', onclick: () => returns(sale, refresh) })
            : null,
          el('button', { class: 'btn ghost', text: 'ویرایش فاکتور', onclick: () => editForm(sale, refresh) }),
          el('button', {
            class: 'btn danger',
            text: 'حذف فاکتور',
            onclick: async () => {
              const ok = await dialog({ title: 'حذف فاکتور فروش', body: 'فقط در صورت اشتباه ثبت شدن استفاده کنید. گزارش‌های این دوره دوباره محاسبه می‌شوند و در «سابقهٔ تغییرات» ثبت می‌گردد.', confirmText: 'حذف', danger: true, fields: [{ name: 'reason', label: 'دلیل حذف *', required: true, multiline: true }] });
              if (!ok?.ok) return;
              await del(`/api/sales/${sale.id}`, { reason: ok.values.reason });
              toast('فاکتور حذف شد.');
              location.hash = '#/sales';
              refresh();
            },
          }),
        ]),
      ]),
    ]),
  );

  async function editForm(sale, refresh) {
    const products = (await get('/api/products')).items;
    const card = entryForm(products, { existing: sale, onSaved: () => refresh(), onCancelled: () => refresh() });
    box.replaceChildren(
      el('div', { class: 'card' }, [el('div', { class: 'card-b' }, [el('button', { class: 'btn ghost sm', text: 'انصراف', onclick: () => refresh() })])]),
      card,
    );
  }

  async function receipt(sale, refresh) {
    const res = await dialog({
      title: 'وصول مطالبات',
      body: `ماندهٔ این فاکتور: ${money(sale.computed.outstanding_rial, { unit, withUnit: true })}`,
      confirmText: 'ثبت وصول',
      fields: [
        { name: 'amount_toman', label: 'مبلغ دریافتی (تومان) *', required: true, placeholder: String(Math.round(sale.computed.outstanding_rial / 10)) },
        { name: 'date', label: 'تاریخ (YYYY-MM-DD)', placeholder: appState.clock.today },
        { name: 'note', label: 'یادداشت' },
      ],
    });
    if (!res?.ok) return;
    const out = await post('/api/settlements', {
      type: 'customer_receipt',
      sale_id: sale.id,
      customer_name: sale.customer_name || undefined,
      amount_toman: parseNum(res.values.amount_toman),
      date: res.values.date || appState.clock.today,
      payment_method: sale.payment_method === 'credit' ? 'cash' : sale.payment_method,
      note: res.values.note || undefined,
      dedupe_key: stickyKey('receipt'),
    });
    releaseKey('receipt');
    toast(out.message || 'وصول ثبت شد.');
    refresh();
  }

  async function returns(sale, refresh) {
    const options = sale.lines.filter((l) => l.kind === 'sale');
    const chosen = options[0];
    const res = await dialog({
      title: 'ثبت مرجوعی',
      body: 'مبلغ مرجوعی به درآمد دوره اضافه (منفی) و کالا با همان بهای تمام‌شده به موجودی برمی‌گردد.',
      confirmText: 'ثبت مرجوعی',
      fields: [
        { name: 'origin_line_id', label: `ردیف مرجوع‌شده (${options.map((o, i) => `${i + 1}:${o.description}`).join(' ، ')}) *`, required: true, placeholder: String(chosen.id) },
        { name: 'qty', label: 'مقدار مرجوعی *', required: true, placeholder: String(chosen.qty_x1000 / 1000) },
        { name: 'unit_price_toman', label: 'بهای هر واحد (تومان)', placeholder: String(Math.round(chosen.unit_price_rial / 10)) },
      ],
    });
    if (!res?.ok) return;
    const origin = options.find((o) => String(o.id) === String(res.values.origin_line_id)) || chosen;
    const body = {
      date: appState.clock.today,
      time: appState.clock.time,
      payment_method: 'credit',
      received_toman: 0,
      customer_name: sale.customer_name || undefined,
      note: `مرجوعی از فاکتور ${toFa(sale.id)}`,
      dedupe_key: stickyKey('return'),
      lines: [
        {
          kind: 'return',
          product_id: origin.product_id,
          description: origin.description,
          qty: String(parseNum(res.values.qty)),
          unit_price_rial: res.values.unit_price_toman ? Math.round(parseNum(res.values.unit_price_toman) * 10) : origin.unit_price_rial,
          discount_rial: 0,
          origin_line_id: origin.id,
        },
      ],
    };
    const out = await post('/api/sales', body);
    releaseKey('return');
    toast(out.message || 'مرجوعی ثبت شد.');
    refresh();
  }
}

const methodLabel = (m) => ({ cash: 'نقدی', card: 'کارت', transfer: 'انتقال بانکی', credit: 'نسیه', other: 'سایر' })[m] || m;
