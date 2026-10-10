// تنظیمات — اطلاعات کسب‌وکار، واحد نمایش، دورهٔ پایهٔ تورم، کاربران، پشتیبان‌گیری،
// سابقهٔ تغییرات و ناحیهٔ خطر.
import { el, clear, toast, dialog, money, jalaliText, toFa, periodLabel } from '../util.js';
import { get, put, post } from '../api.js';
import { tableOf, Chips, TextField, SelectField, setDisplayUnit } from '../components.js';
import { state as appState } from '../app.js';

export async function render(host, { refresh }) {
  clear(host);
  const data = await get('/api/settings');
  const s = data.settings || {};
  const root = el('div', { class: 'grid', style: 'gap:12px' });
  const owner = appState.me?.role === 'owner';

  /* ------------------------------------------------- business identity */
  const name = TextField({ label: 'نام کسب‌وکار', value: s.business_name || '' });
  const ownerName = TextField({ label: 'نام مالک', value: s.owner_name || '' });
  const phone = TextField({ label: 'تلفن', value: s.phone || '' });
  const address = TextField({ label: 'آدرس', value: s.address || '' });
  const openingInput = el('input', { class: 'control', type: 'date', value: s.opening_date || '', max: appState.clock.today });
  const opening = { node: el('div', { class: 'field' }, [el('label', { text: 'تاریخ شروع فعالیت (افتتاح)' }), openingInput, el('div', { class: 'hint', text: 'مبنای «سال اول» و اولین موجودی opening.' })]), value: () => openingInput.value || null };
  const saveBiz = el('button', { class: 'btn', text: 'ذخیره', type: 'button' });
  saveBiz.addEventListener('click', async () => {
    saveBiz.disabled = true;
    try {
      await put('/api/settings', {
        business_name: name.value() || null,
        owner_name: ownerName.value() || null,
        phone: phone.value() || null,
        address: address.value() || null,
        opening_date: opening.value() || null,
      });
      toast('تنظیمات ذخیره شد.');
      await refresh();
    } catch (e) {
      toast(e.message, { type: 'err' });
    } finally {
      saveBiz.disabled = false;
    }
  });
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'کسب‌وکار' })]),
      el('div', { class: 'card-b' }, [
        owner ? null : el('div', { class: 'notice info' }, ['ویرایش تنظیمات فقط برای حساب مالک فعال است.']),
        el('div', { class: 'grid cols-2' }, [name.node, ownerName.node]),
        el('div', { class: 'grid cols-2' }, [phone.node, opening.node]),
        address.node,
        saveBiz,
      ]),
    ]),
  );

  /* ------------------------------------------------------- display prefs */
  const unitChips = Chips({
    label: 'واحد نمایش ارقام',
    value: s.currency_display_unit || 'toman',
    options: [
      { value: 'toman', label: 'تومان' },
      { value: 'rial', label: 'ریال' },
    ],
    onChange: async (v) => {
      setDisplayUnit(v);
      await put('/api/settings', { currency_display_unit: v });
      toast(`واحد نمایش: ${v === 'toman' ? 'تومان' : 'ریال'}`);
      refresh();
    },
  });
  const baseSel = SelectField({
    label: 'دورهٔ پایهٔ مقایسهٔ سود واقعی',
    options: periods(24).map((p) => ({ value: p, label: periodLabel(p) })),
    value: s.inflation_base_period || appState.clock.today_period,
  });
  baseSel.node.addEventListener('change', async () => {
    await put('/api/settings', { inflation_base_period: baseSel.value() });
    toast('دورهٔ پایه ذخیره شد؛ مقایسه‌های «سود واقعی» بر همین اساس محاسبه می‌شوند.');
  });
  const defAcc = SelectField({
    label: 'حساب پیش‌فرض صندوق',
    options: [{ value: '', label: '— بدون تغییر —' }].concat(data.accounts.filter((a) => !a.archived_at).map((a) => ({ value: String(a.id), label: a.name }))),
    value: s.default_account_id ? String(s.default_account_id) : '',
  });
  defAcc.node.addEventListener('change', async () => {
    if (!defAcc.value()) return;
    await put('/api/settings', { default_account_id: Number(defAcc.value()) });
    toast('حساب پیش‌فرض تنظیم شد.');
  });
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'نمایش و مقایسه' })]),
      el('div', { class: 'card-b' }, [
        unitChips.node,
        el('div', { class: 'hint', text: 'یک تومان = ده ریال. همهٔ ارقام در پایگاه‌داده به ریال ذخیره می‌شوند تا خطای اعشار از بین برود.' }),
        el('div', { class: 'grid cols-2', style: 'margin-top:10px' }, [baseSel.node, defAcc.node]),
        el('div', { class: 'notice info' }, [
          `منطقهٔ زمانی سرور: ${data.tz} · امروز: ${jalaliText(data.today, { style: 'long' })} · واحد پول نمایشی با انتخاب شما در همهٔ بخش‌ها اعمال می‌شود.`,
        ]),
      ]),
    ]),
  );

  /* ------------------------------------------------------------ security */
  const p1 = TextField({ label: 'رمز فعلی', type: 'password' });
  const p2 = TextField({ label: 'رمز جدید', type: 'password', hint: 'حداقل ۱۰ کاراکتر، نه مثل نام کاربری، نه تکراری' });
  const pSave = el('button', { class: 'btn subtle', text: 'تغییر رمز عبور', type: 'button' });
  pSave.addEventListener('click', async () => {
    pSave.disabled = true;
    try {
      const out = await post('/api/auth/password', { current_password: p1.value(), new_password: p2.value() });
      toast(out.message);
      location.reload();
    } catch (e) {
      toast(e.message, { type: 'err', timeout: 7000 });
      pSave.disabled = false;
    }
  });
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'دسترسی و کاربران' })]),
      el('div', { class: 'card-b' }, [
        tableOf(
          [
            { label: 'نام کاربری', render: (u) => el('b', { text: u.username }) },
            { label: 'نمایش', render: (u) => u.display_name || '—' },
            { label: 'نقش', render: (u) => el('span', { class: `badge ${u.role === 'owner' ? 'ok' : u.role === 'staff' ? 'info' : ''}`, text: u.role === 'owner' ? 'مالک' : u.role === 'staff' ? 'کارمند' : 'فقط‌خواندنی' }) },
            { label: 'آخرین ورود', render: (u) => (u.last_login_at ? jalaliText(u.last_login_at.slice(0, 10), { style: 'short' }) : 'ورودی نداشته') },
          ],
          data.users,
          {},
        ),
        el('div', { class: 'notice info' }, [
          'نقش‌ها: مالک (همه‌چیز)، کارمند (ثبت فروش/خرید/هزینه بدون حذف و بدون تنظیمات)، فقط‌خواندنی (مشاهده). اعتبارسنجی و اجازهٔ دسترسی در سرور انجام می‌شود، نه در مرورگر. رمزها با scrypt هش شده و هیچ‌کلید یا رمز عبوری به مرورگر فرستاده نمی‌شود.',
        ]),
        el('div', { class: 'grid cols-2', style: 'margin-top:10px' }, [p1.node, p2.node]),
        pSave,
      ]),
    ]),
  );

  /* --------------------------------------------------------- data files */
  root.appendChild(
    el('section', { class: 'card' }, [
      el('div', { class: 'card-h' }, [el('h2', { text: 'پشتیبان‌گیری و خروجی' })]),
      el('div', { class: 'card-b' }, [
        el('div', { class: 'btn-row' }, [
          el('a', { class: 'btn', href: '/api/export.json', download: true, text: '⬇️ پشتیبان کامل (JSON)' }),
          el('a', { class: 'btn ghost', href: '/api/export.csv?table=sales', download: true, text: 'CSV فروش' }),
          el('a', { class: 'btn ghost', href: '/api/export.csv?table=expenses', download: true, text: 'CSV هزینه' }),
          el('a', { class: 'btn ghost', href: '/api/export.csv?table=inventory', download: true, text: 'CSV موجودی' }),
          el('a', { class: 'btn ghost', href: '/api/export.csv?table=monthly', download: true, text: 'CSV گزارش ماهانه' }),
          el('a', { class: 'btn ghost', href: '/api/export.csv?table=fx', download: true, text: 'CSV نرخ دلار' }),
        ]),
        el('div', { class: 'notice info' }, [
          `پایگاه‌داده: ${data.db || 'SQLite'} · ذخیره‌سازی فایل: ${data.db_persisted ? 'فعال' : 'غیرفعال (حالت فقط‌خواندده)'} · `,
          'پشتیبان JSON شامل همهٔ جداول (به‌جز هش رمز عبور) است؛ با آن می‌توانید در دستگاه دیگری ادامه دهید. CSV‌ها با BOM ذخیره می‌شوند تا در Excel فارسی‌ها به‌هم‌نریزد.',
        ]),
      ]),
    ]),
  );

  /* ------------------------------------------------------- audit trail */
  if (owner) {
    const audit = await get('/api/audit?limit=60');
    root.appendChild(
      el('section', { class: 'card' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'سابقهٔ تغییرات (دفتر رویدادها)' }), el('span', { class: 'spacer' }), el('span', { class: 'hint', style: 'margin:0', text: `${toFa(audit.items.length)} رویداد اخیر` })]),
        el('div', { class: 'card-b' }, [
          tableOf(
            [
              { label: 'زمان', render: (a) => jalaliText((a.created_at || '').slice(0, 10), { style: 'short' }) + ' ' + toFa((a.created_at || '').slice(11, 16)) },
              { label: 'کاربر', render: (a) => a.username || '—' },
              { label: 'کنش', render: (a) => el('span', { class: `badge ${/delete|reset/.test(a.action) ? 'bad' : /update|correction|select/.test(a.action) ? 'warn' : 'ok'}`, text: a.action }) },
              { label: 'جدول', render: (a) => a.entity },
              { label: 'شناسه', render: (a) => (a.entity_id == null ? '—' : toFa(a.entity_id)) },
              {
                label: 'شرح',
                render: (a) => el('span', { text: [a.reason, a.note, a.before_json && a.after_json ? `مقادیر: ${shortDiff(a)}` : null].filter(Boolean).join(' — ') || '—' }),
              },
            ],
            audit.items,
            { empty: 'رویدادی ثبت نشده است.', cls: 'table-compact' },
          ),
        ]),
      ]),
    );
  }

  /* -------------------------------------------------------- danger zone */
  if (owner) {
    const health = await get('/api/health').catch(() => ({}));
    root.appendChild(
      el('section', { class: 'card danger' }, [
        el('div', { class: 'card-h' }, [el('h2', { text: 'ناحیهٔ خطر' })]),
        el('div', { class: 'card-b' }, [
          el('div', { class: 'notice warn' }, ['پاک‌سازی کامل فقط برای این است که خودتان با داده‌های واقعی شروع کنید. قبل از حذف، یک پشتیبان خودکار ساخته می‌شود و هیچ داده‌ای بدون تایپ عبارت «پاک کن» حذف نمی‌شود.']),
          el('div', { class: 'btn-row' }, [
            el('button', {
              class: 'btn subtle',
              text: 'پیش‌نمایش پاک‌سازی',
              onclick: async () => {
                const p = await post('/api/reset-preview', {});
                dialog({
                  title: 'چه چیزی پاک خواهد شد؟',
                  body: `فروش: ${toFa(p.rows.sales)} · خرید: ${toFa(p.rows.purchases)} · هزینه: ${toFa(p.rows.expenses)} · گزارش بسته‌شده: ${toFa(p.rows.snapshots)}\nارزش موجودی فعلی ${money(p.inventory_value_rial, { withUnit: true })} و نقدینگی ${money(p.cash_total_rial, { withUnit: true })} نیز حذف می‌شود.\n\nنرخ دلارهای ثبت‌شده، فرض‌های تورم، حساب‌های پولی و حساب کاربری شما پاک نمی‌شوند (پشتیبان کامل قبلش ساخته می‌شود).`,
                  confirmText: 'فهمیدم',
                });
              },
            }),
            el('button', {
              class: 'btn danger',
              text: 'پاک‌سازی کامل داده‌ها',
              onclick: async () => {
                const res = await dialog({
                  title: 'پاک‌سازی کامل',
                  body: 'این کار برگشت‌پذیر نیست (پشتیبان خودکار در سرور ساخته می‌شود). برای تأیید عبارت پاک کن را تایپ کنید.',
                  confirmText: 'پاک کن',
                  danger: true,
                  requireText: 'پاک کن',
                });
                if (!res?.ok) return;
                try {
                  const out = await post('/api/reset-confirm', { confirm: res.values.confirm });
                  toast(out.message || 'پاک شد.');
                  setTimeout(() => location.reload(), 800);
                } catch (e) {
                  toast(e.message, { type: 'err', timeout: 8000 });
                }
              },
            }),
          ]),
          el('div', { class: 'hint' }, [
            `نسخهٔ برنامه ${toFa(health.version || '—')} · Node ${health.node || '—'} · پایگاه‌داده ${health.db || '—'} · وضعیت سرور: ${health.ok ? 'سالم' : '—'}`,
          ]),
        ]),
      ]),
    );
  }

  root.appendChild(
    el('div', { class: 'card' }, [
      el('div', { class: 'card-b hint' }, [
        `شمار رکوردها — کالا: ${toFa(data.products_count)} · نرخ دلار: ${toFa(data.fx_records)} · فرض تورم: ${toFa(data.inflation_records)} · حساب‌ها: ${toFa(data.accounts.length)}`,
      ]),
    ]),
  );

  host.appendChild(root);
}

function shortDiff(a) {
  try {
    const before = JSON.parse(a.before_json || '{}');
    const after = JSON.parse(a.after_json || '{}');
    const keys = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!keys.length) return 'بدون تغییر عددی';
    return keys.slice(0, 3).map((k) => `${k}: ${typeof after[k] === 'number' ? money(after[k], { withUnit: false }) : after[k]}`).join('، ');
  } catch {
    return '—';
  }
}

function periods(n) {
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
