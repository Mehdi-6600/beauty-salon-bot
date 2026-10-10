// Money handling: the app stores whole rial as integers, so every parsing and
// formatting rule here is what keeps Persian input exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDigits,
  parseAmountToRial,
  parseQtyX1000,
  parsePctX100,
  divRound,
  mulDiv,
  sumInt,
  safeAdd,
  rialToToman,
  formatRial,
  formatQty,
  formatPct,
  MAX_ABS_RIAL,
  RIAL_PER_TOMAN,
  QTY_SCALE,
} from '../server/money.js';

test('Persian and Arabic-Indic digits, separators and words are normalised', () => {
  assert.equal(normalizeDigits('۱۲۳٤٥۶'), '123456');
  assert.equal(normalizeDigits('۱٬۲۳۴٬۵۶۷٫۵'), '1234567.5', 'the Arabic grouping mark must not become a decimal point');
  assert.equal(normalizeDigits('۱,۲۳۴ ریال'), '1234', 'unit words pasted from a chat are tolerated');
  assert.equal(normalizeDigits('منفی ۵۰۰'), '-500');
  assert.equal(normalizeDigits('(۵۰۰)'), '-500', 'accounting parentheses mean negative');
});

test('toman ⇄ rial is exact and never drifts', () => {
  assert.equal(RIAL_PER_TOMAN, 10n);
  assert.equal(parseAmountToRial('1', 'toman'), 10);
  assert.equal(parseAmountToRial('0.1', 'toman'), 1);
  assert.equal(parseAmountToRial('1', 'rial'), 1);
  assert.equal(parseAmountToRial('۹۵۰٬۰۰۰', 'toman'), 9_500_000);
  assert.equal(rialToToman(9_500_000), 950_000);
  // 1 rial cannot be represented in toman: that input must be rejected, not rounded
  assert.equal(parseAmountToRial('0.05', 'toman'), null);
});

test('amount parsing rejects junk instead of guessing', () => {
  assert.equal(parseAmountToRial('', 'toman'), null);
  assert.equal(parseAmountToRial('abc', 'toman'), null);
  assert.equal(parseAmountToRial('1.2.3', 'toman'), null);
  assert.equal(parseAmountToRial('-5', 'toman'), -50, 'sign is carried through; per-field rules decide if negative is allowed');
  assert.equal(parseAmountToRial(String(MAX_ABS_RIAL), 'rial'), null, 'overflowing values are refused');
  assert.equal(parseAmountToRial(1_000, 'toman'), 10_000, 'numbers are accepted too');
  assert.equal(parseAmountToRial('۱٬۲۳۴٬۵۶۷٫۵', 'toman'), 12_345_675, 'grouped Persian decimal → exact rial');
  assert.equal(parseAmountToRial(1.234, 'toman'), null, 'sub-rial precision is refused, not rounded');
});

test('quantities keep three decimals exactly', () => {
  assert.equal(QTY_SCALE, 1000);
  assert.equal(parseQtyX1000('2'), 2_000);
  assert.equal(parseQtyX1000('۱٫۵'), 1_500);
  assert.equal(parseQtyX1000(0.25), 250);
  assert.equal(parseQtyX1000('0.0005'), null, 'a fourth decimal is refused');
  assert.equal(parseQtyX1000('-1', { allowNegative: true }), -1_000);
  assert.equal(parseQtyX1000('-1'), null);
  assert.equal(parseQtyX1000('0'), 0, 'zero parses; the sale/purchase layer rejects an empty line');
});

test('percent fields are stored ×100 and rounded half away from zero', () => {
  assert.equal(parsePctX100('2.5'), 250);
  assert.equal(parsePctX100('۳٫۵'), 350);
  assert.equal(parsePctX100('0.004'), null, 'two decimal places is the precision of a percent field');
  assert.equal(divRound(5n, 10n), 1n, '0.5 rounds up, not to even');
  assert.equal(divRound(-5n, 10n), -1n, 'and −0.5 rounds away from zero');
  assert.equal(divRound(4n, 10n), 0n);
});

test('multiplication and division of money never use floats', () => {
  // 3 × 1 333 333 / 7 would be 571 428.428… in floating point
  // The primitives stay BigInt so a BigInt can never be silently rounded away;
  // callers convert with Number() when they store or send the value.
  assert.equal(mulDiv(3, 1_333_333, 7), 571_428n);
  assert.equal(mulDiv(1, 1, 3), 0n);
  assert.equal(mulDiv(2, 1, 3), 1n);
  assert.equal(Number(mulDiv(3, 1_333_333, 7)), 571_428);
  assert.throws(() => mulDiv(1, 1, 0), /division by zero/);
});

test('sums are exact and overflow-guarded', () => {
  assert.equal(sumInt([1, 2, 3]), 6);
  assert.equal(sumInt([1, null, undefined, '', 2]), 3);
  assert.equal(sumInt([MAX_ABS_RIAL, -MAX_ABS_RIAL]), 0);
  assert.throws(() => sumInt([1.5]), TypeError);
  assert.throws(() => safeAdd(MAX_ABS_RIAL, MAX_ABS_RIAL), RangeError);
});

test('display formats are Persian, grouped, and signed', () => {
  assert.equal(formatRial(9_500_000), '۹۵۰٬۰۰۰ تومان');
  assert.equal(formatRial(9_500_000, { unit: 'rial' }), '۹٬۵۰۰٬۰۰۰ ریال');
  assert.equal(formatRial(-12_345), '−۱٬۲۳۵ تومان');
  assert.equal(formatRial(0), '۰ تومان');
  assert.equal(formatRial(1_000, { digits: 'en' }), '100 تومان');
  assert.equal(formatQty(2_500), '۲٫۵');
  assert.equal(formatQty(2_000), '۲');
  assert.equal(formatPct(-525), '−۵٫۲۵٪');
  assert.equal(formatPct(525, { signed: false }), '۵٫۲۵٪');
});
