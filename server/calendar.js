/**
 * Hyper Sina — Jalali (Persian calendar) support + shop clock.
 *
 * All transaction timestamps are stored as *shop-local* naive strings
 * (`YYYY-MM-DD` / `YYYY-MM-DDTHH:mm`) because a shop owner records what their
 * own wall clock said. Reports are grouped by Jalali month/year, which is what
 * an Iranian owner actually reasons about ("فروردین ۱۴۰۵"). Each transaction
 * row therefore also carries derived `jperiod` ('YYYY-MM') and `jyear`
 * ('YYYY') columns, computed here at write time and indexed for fast filtering.
 *
 * Algorithm: the standard 33-year-cycle Persian calendar arithmetic (jalaali-js
 * lineage). It is cross-validated against ICU's `persian` calendar in
 * test/calendar.test.js so a typo can never silently corrupt report grouping.
 */

const breaks = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

const div = (a, b) => Math.floor(a / b);
const mod = (a, b) => a - Math.floor(a / b) * b;

function jalCal(jy) {
  const bl = breaks.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = breaks[0];
  let jump = -14;

  for (let i = 1; i < bl; i += 1) {
    const jm = breaks[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;

  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ -= 1;

  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;

  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

/** Persian leap years follow the 33-year cycle encoded in `breaks`. */
export function isJalaaliLeapYear(jy) {
  return jalCal(jy).leap === 0;
}

export function jalaaliMonthLength(jy, jm) {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaaliLeapYear(jy) ? 30 : 29;
}

/* ── day-number arithmetic ──────────────────────────────────────────────────
 * gregorianToJdn uses the verified civil-calendar formula (Fliegel & Van
 * Flandern); jdnToGregorian goes through the Unix epoch, which cannot drift.
 */
const UNIX_EPOCH_JDN = 2440588; // 1970-01-01

export function gregorianToJdn(gy, gm, gd) {
  const a = Math.floor((14 - gm) / 12);
  const y = gy + 4800 - a;
  const m2 = gm + 12 * a - 3;
  return gd + Math.floor((153 * m2 + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

export function jdnToGregorian(jdn) {
  const d = new Date(Date.UTC(1970, 0, 1) + (jdn - UNIX_EPOCH_JDN) * 86400000);
  return { gy: d.getUTCFullYear(), gm: d.getUTCMonth() + 1, gd: d.getUTCDate() };
}

/** Gregorian 3-month day index (0..365) used to shift inside a Persian year. */
function dayInJalaliYear(jm, jd) {
  return (jm <= 7 ? (jm - 1) * 31 : 186 + (jm - 7) * 30) + (jd - 1);
}

export function jalaliToJdn(jy, jm, jd) {
  if (jm < 1 || jm > 12) throw new RangeError('jalali month out of range');
  const max = jalaaliMonthLength(jy, jm);
  if (jd < 1 || jd > max) throw new RangeError(`jalali day ${jd} out of range for ${jy}-${jm} (1..${max})`);
  return jdnOfNowruz(jy) + dayInJalaliYear(jm, jd);
}

export function jdnToJalali(jdn) {
  const { gy } = jdnToGregorian(jdn);
  let jy = gy - 621;
  let nowruz = jdnOfNowruz(jy);
  if (jdn < nowruz) {
    jy -= 1;
    nowruz = jdnOfNowruz(jy);
  } else if (jdn >= jdnOfNowruz(jy + 1)) {
    jy += 1;
    nowruz = jdnOfNowruz(jy);
  }
  const offset = jdn - nowruz; // 0 .. 365
  let jm = 1;
  let day = offset + 1;
  for (let i = 1; i <= 12; i += 1) {
    const len = jalaaliMonthLength(jy, i);
    if (day <= len) {
      jm = i;
      break;
    }
    day -= len;
  }
  return { jy, jm, jd: day };
}

const nowruzCache = new Map();
export function jdnOfNowruz(jy) {
  if (nowruzCache.has(jy)) return nowruzCache.get(jy);
  const r = jalCal(jy);
  const jdn = gregorianToJdn(r.gy, 3, r.march);
  nowruzCache.set(jy, jdn);
  return jdn;
}

const pad2 = (n) => String(n).padStart(2, '0');

export function gregorianToJalali(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const { jy, jm, jd } = jdnToJalali(gregorianToJdn(+m[1], +m[2], +m[3]));
  return {
    jy,
    jm,
    jd,
    year: String(jy),
    month: pad2(jm),
    day: pad2(jd),
    period: `${jy}-${pad2(jm)}`,
    date: `${jy}-${pad2(jm)}-${pad2(jd)}`,
  };
}

export function jalaliToGregorian(jy, jm, jd) {
  const { gy, gm, gd } = jdnToGregorian(jalaliToJdn(jy, jm, jd));
  return `${gy}-${pad2(gm)}-${pad2(gd)}`;
}

/** Gregorian day-number of the first/last day of a Jalali month or year. */
export function jalaliRange(period, granularity = 'month') {
  if (granularity === 'year') {
    const jy = Number(period);
    if (!Number.isInteger(jy)) return null;
    const lastMonth = jalaaliMonthLength(jy, 12);
    return {
      from: jalaliToGregorian(jy, 1, 1),
      to: jalaliToGregorian(jy, 12, lastMonth),
      jalali: { jy, jm: null },
    };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(String(period));
  if (!m) return null;
  const jy = +m[1];
  const jm = +m[2];
  if (jm < 1 || jm > 12) return null;
  return {
    from: jalaliToGregorian(jy, jm, 1),
    to: jalaliToGregorian(jy, jm, jalaaliMonthLength(jy, jm)),
    jalali: { jy, jm },
  };
}

export function jalaliMonthShift(period, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period));
  if (!m) return null;
  let jy = +m[1];
  let jm = +m[2] + delta;
  while (jm < 1) {
    jm += 12;
    jy -= 1;
  }
  while (jm > 12) {
    jm -= 12;
    jy += 1;
  }
  return `${jy}-${pad2(jm)}`;
}

export const JALALI_MONTHS = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

export const WEEKDAYS = ['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'];

export function formatJalaliPeriod(period, { digits = 'fa' } = {}) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return String(period || '');
  const toFa = (s) => (digits === 'fa' ? s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]) : s);
  return `${toFa(JALALI_MONTHS[+m[2] - 1])} ${toFa(m[1])}`;
}

export function formatJalaliYear(year, { digits = 'fa' } = {}) {
  const s = String(year);
  return digits === 'fa' ? s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]) : s;
}

export function formatJalaliDate(dateStr, { digits = 'fa', withDay = true } = {}) {
  const j = gregorianToJalali(dateStr);
  if (!j) return String(dateStr || '');
  const toFa = (s) => (digits === 'fa' ? s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]) : s);
  const base = `${j.year}/${j.month}/${j.day}`;
  if (!withDay) return toFa(base);
  return `${toFa(JALALI_MONTHS[j.jm - 1])} ${toFa(String(+j.day))} ${toFa(j.year)}`;
}

/* ------------------------------------------------------------------ clock -- */

export const DEFAULT_TZ = process.env.HYPER_SINA_TZ || 'Asia/Tehran';

function partsIn(tz, date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  if (out.hour === '24') out.hour = '00';
  return out;
}

/** Current shop-local date & time (used for "today" and default form values). */
export function shopNow(tz = DEFAULT_TZ) {
  const p = partsIn(tz);
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    time: `${p.hour}:${p.minute}`,
    datetime: `${date}T${p.hour}:${p.minute}`,
    iso: new Date().toISOString(),
    tz,
    jalali: gregorianToJalali(date),
    weekday: new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }),
  };
}
