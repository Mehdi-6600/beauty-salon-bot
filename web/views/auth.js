// First-run setup + sign-in. No demo data is ever created here.
import { el, toast } from '../util.js';
import { api, setCsrf } from '../api.js';

/** Mirrors the server policy so the owner gets feedback before a round trip. */
function passwordProblemsClient(pw) {
  if (pw.length < 8) return 'رمز عبور باید حداقل ۸ نویسه باشد.';
  if (/^(12345678|password|123456789|11111111)$/i.test(pw)) return 'این رمز عبور خیلی رایج و ضعیف است.';
  return null;
}

export async function render({ state, onDone, needsSetup }) {
  const host = el('div', { class: 'auth-wrap' });
  const card = el('section', { class: 'card auth-card' });
  card.appendChild(el('div', { class: 'card-b', style: 'text-align:center;padding:22px 20px 6px' }, [
    el('div', { class: 'auth-mark', text: 'هـ' }),
    el('h1', { style: 'font-size:19px;margin:10px 0 2px', text: 'هایپر سینا' }),
    el('p', { class: 'hint', style: 'margin:0', text: needsSetup ? 'حسابدار شخصی فروشگاه — اولین ورود: حساب مالک را بسازید' : 'برای دیدن ارقام مالی وارد شوید' }),
  ]));

  const user = el('input', { class: 'control', name: 'username', autocomplete: 'username', placeholder: 'نام کاربری', required: true });
  const pass = el('input', { class: 'control', type: 'password', name: 'password', autocomplete: needsSetup ? 'new-password' : 'current-password', placeholder: 'رمز عبور', required: true });
  const display = el('input', { class: 'control', name: 'display_name', placeholder: 'نام شما (اختیاری)' });
  const shop = el('input', { class: 'control', name: 'business_name', placeholder: 'نام فروشگاه — پیش‌فرض: هایپر سینا' });
  const err = el('div', { class: 'error-text', hidden: true });
  const submit = el('button', { class: 'btn block', type: 'button', text: needsSetup ? 'ساخت حساب و ورود' : 'ورود' });

  const fields = [
    el('div', { class: 'field' }, [el('label', { text: 'نام کاربری' }), user, needsSetup ? el('div', { class: 'hint', text: 'حروف کوچک انگلیسی، عدد، . _ - (حداقل ۳ نویسه)' }) : null]),
    el('div', { class: 'field' }, [el('label', { text: 'رمز عبور' }), pass, needsSetup ? el('div', { class: 'hint', text: 'حداقل ۸ نویسه. رمز فقط روی سرور با scrypt ذخیره می‌شود.' }) : null]),
    needsSetup ? el('div', { class: 'field' }, [el('label', { text: 'نام نمایشی' }), display]) : null,
    needsSetup ? el('div', { class: 'field' }, [el('label', { text: 'نام فروشگاه' }), shop]) : null,
  ];
  card.appendChild(el('div', { class: 'card-b' }, [el('form', { onsubmit: (e) => { e.preventDefault(); save(); } }, [el('div', {}, fields), err, submit])]));
  card.appendChild(
    el('div', { class: 'card-b', style: 'padding-top:0' }, [
      el('div', { class: 'notice info' }, [
        'همهٔ ارقام فقط در دیتابیس همین برنامه ذخیره می‌شوند. پس از ورود می‌توانید ماندهٔ بازگشایی صندوق، موجودی اولیه و نرخ دلار را وارد کنید — هیچ داده‌ای به‌صورت نمونه ساخته نمی‌شود.',
      ]),
    ]),
  );

  async function save() {
    err.hidden = true;
    if (needsSetup) {
      const problem = passwordProblemsClient(pass.value);
      if (problem) return show(problem);
    }
    submit.disabled = true;
    try {
      const body = { username: user.value.trim(), password: pass.value };
      if (needsSetup) {
        body.display_name = display.value.trim();
        if (shop.value.trim()) body.business_name = shop.value.trim();
      }
      const out = await api(needsSetup ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body });
      setCsrf(out.csrf);
      state.me = out.user;
      if (needsSetup && body.business_name) {
        await api('/api/settings', { method: 'PUT', body: { business_name: body.business_name, currency_display_unit: 'toman' } }).catch(() => {});
      }
      toast(needsSetup ? 'حساب ساخته شد. خوش آمدید.' : 'خوش آمدید.');
      await onDone();
    } catch (e) {
      show(e.message || 'ورود ناموفق بود.');
      submit.disabled = false;
    }
  }

  function show(msg) {
    err.textContent = msg;
    err.hidden = false;
  }

  host.appendChild(card);
  setTimeout(() => (needsSetup ? user : pass).focus(), 60);
  return host;
}
