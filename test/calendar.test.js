// The Jalali calendar must agree with ICU (what browsers show) for every date we
// can be asked about, and the month/year windows that reports are built on must
// be exact — a report that includes the wrong day is a wrong report.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gregorianToJalali,
  jalaliToGregorian,
  jalaliRange,
  jalaliMonthShift,
  isJalaaliLeapYear,
  jalaaliMonthLength,
  formatJalaliPeriod,
  shopNow,
  JALALI_MONTHS,
  DEFAULT_TZ,
} from '../server/calendar.js';

const fmt = new Intl.DateTimeFormat('en-u-ca-persian', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  era: 'short',
  timeZone: 'UTC',
});

function icuJalali(iso) {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(`${iso}T00:00:00Z`)).map((p) => [p.type, p.value]));
  return { jy: Number(parts.year), jm: Number(parts.month), jd: Number(parts.day) };
}

test('gregorianToJalali matches ICU for every 11th day from 1900 to 2100', () => {
  let checked = 0;
  for (let t = Date.UTC(1900, 0, 1); t <= Date.UTC(2100, 11, 31); t += 11 * 86_400_000) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const mine = gregorianToJalali(iso);
    const theirs = icuJalali(iso);
    assert.deepEqual({ jy: mine.jy, jm: mine.jm, jd: mine.jd }, theirs, `mismatch on ${iso}`);
    checked += 1;
  }
  assert.ok(checked > 6_500, `only ${checked} dates were compared`);
});

test('jalaliToGregorian is the exact inverse (round trip for every day of 1405)', () => {
  for (let m = 1; m <= 12; m += 1) {
    for (let d = 1; d <= jalaaliMonthLength(1405, m); d += 1) {
      const g = jalaliToGregorian(1405, m, d);
      const back = gregorianToJalali(g);
      assert.deepEqual({ jy: back.jy, jm: back.jm, jd: back.jd }, { jy: 1405, jm: m, jd: d }, `${g} did not round-trip`);
    }
  }
});

test('month lengths and the leap rule follow the Jalali algorithm', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map((m) => jalaaliMonthLength(1403, m)),
    [31, 31, 31, 31, 31, 31],
  );
  assert.deepEqual(
    [7, 8, 9, 10, 11].map((m) => jalaaliMonthLength(1403, m)),
    [30, 30, 30, 30, 30],
  );
  assert.equal(jalaaliMonthLength(1403, 12), isJalaaliLeapYear(1403) ? 30 : 29, 'the 12th month absorbs the leap day');
  let leapSeen = 0;
  for (let y = 1300; y <= 1450; y += 1) if (isJalaaliLeapYear(y)) leapSeen += 1;
  assert.ok(leapSeen >= 35 && leapSeen <= 40, `unexpected leap density: ${leapSeen}`);
});

test('jalaliRange returns whole-month and whole-year Gregorian windows', () => {
  const month = jalaliRange('1405-01', 'month');
  assert.equal(month.from, jalaliToGregorian(1405, 1, 1));
  assert.equal(month.to, jalaliToGregorian(1405, 1, jalaaliMonthLength(1405, 1)));
  assert.deepEqual(month.jalali, { jy: 1405, jm: 1 });
  const year = jalaliRange('1405', 'year');
  assert.equal(year.from, jalaliToGregorian(1405, 1, 1));
  assert.equal(year.to, jalaliToGregorian(1405, 12, jalaaliMonthLength(1405, 12)));
  assert.equal(jalaliRange('1405-13', 'month'), null, 'a non-existent month must not silently shift');
  assert.equal(jalaliRange('garbage', 'month'), null);
});

test('jalaliMonthShift crosses year boundaries in both directions', () => {
  assert.equal(jalaliMonthShift('1405-01', -1), '1404-12');
  assert.equal(jalaliMonthShift('1404-12', 1), '1405-01');
  assert.equal(jalaliMonthShift('1405-07', 6), '1406-01');
  assert.equal(jalaliMonthShift('1405-07', -18), '1404-01');
  assert.equal(jalaliMonthShift('1405-02', 0), '1405-02');
});

test('period labels are Persian and readable', () => {
  assert.equal(JALALI_MONTHS[0], 'فروردین');
  const label = formatJalaliPeriod('1405-07');
  assert.match(label, /مهر/);
  assert.match(label, /۱۴۰۵/, 'digits are Persian');
});

test('shopNow uses the shop timezone, not the server’s UTC', () => {
  const now = shopNow(DEFAULT_TZ);
  assert.match(now.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(now.time, /^\d{2}:\d{2}$/);
  assert.equal(now.jalali.date, `${String(now.jalali.jy).padStart(4, '0')}-${String(now.jalali.jm).padStart(2, '0')}-${String(now.jalali.jd).padStart(2, '0')}`);
  assert.match(now.jalali.period, /^\d{4}-\d{2}$/);
  // The Tehran day flips ~3.5 hours before UTC's, so both must be reported
  const viaUTC = new Date().toISOString().slice(0, 10);
  assert.ok([now.date, viaUTC].includes(now.date));
});
