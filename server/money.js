/**
 * Hyper Sina — decimal-safe money & quantity helpers.
 *
 * Storage contract (enforced everywhere):
 *   money  → INTEGER columns named `*_rial`  (1 toman = 10 rial; rial is the atomic unit)
 *   qty    → INTEGER columns named `*_x1000` (quantity × 1000, so 1.750 kg = 1750)
 *   rates  → INTEGER `rate_toman_x100` (toman × 100, so 95,432.10 toman = 9543210)
 *   percents → INTEGER `*_pct_x100` (percent × 100, so 3.50% = 350)
 *
 * Rials are always whole integers; no floating point is ever used for totals or
 * sums. Multiplications/divisions go through BigInt (see mulDiv / parseAmount)
 * so that qty × price cannot lose precision or overflow the 2^53 double limit.
 */

export const MAX_ABS_RIAL = 9_000_000_000_000_000; // < 2^53, keeps addition/money math exact
export const RIAL_PER_TOMAN = 10n;
export const QTY_SCALE = 1000;

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Normalise Persian/Arabic digits, thousands separators, spaces. */
export function normalizeDigits(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  // A pasted amount usually carries its unit or a Persian minus word; accepting
  // it is friendlier than rejecting the tap. Letters that are not these are left
  // alone so real typos still fail loudly.
  s = s.replace(/تومان|ریال|ريال|تمن/g, '');
  if (/منفی/.test(s)) s = '-' + s.replace(/منفی/g, '');
  s = s.replace(/−/g, '-').replace(/٭|\*/g, '');
  const parenthesised = /^\((-?\s*[\d٬,.۰-۹\s]+)\)$/.exec(s.trim());
  if (parenthesised) s = `-${parenthesised[1].replace(/-/g, '')}`;
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[۰-۹]/g, (c) => String(FA_DIGITS.indexOf(c)));
  s = s.replace(/[٠-٩]/g, (c) => String(AR_DIGITS.indexOf(c)));
  s = s.replace(/[\s_]/g, '');
  s = s.replace(/[٫،]/g, '.');
  s = s.replace(/[٬\u066B]/g, ''); // Arabic thousands separator: a grouping mark, not a decimal point
  s = s.replace(/,/g, ''); // Latin thousands separator
  return s.replace(/\s/g, '');
}

/**
 * Parse a user-supplied amount into whole rial.
 * unit: 'toman' | 'rial'. Fractional toman (e.g. 12.5) is allowed only if it maps to
 * whole rial. Returns null when the value is not a valid, in-range amount.
 */
export function parseAmountToRial(raw, unit = 'toman') {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && !Number.isFinite(raw)) return null;
  const s = normalizeDigits(raw);
  if (!/^-?\d+(\.\d{1,9})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [intPart, fracPart = ''] = body.split('.');
  if (intPart.length > 15) return null;
  const digits = intPart + fracPart;
  const scale = 10n ** BigInt(fracPart.length); // value = digits / scale, in `unit`
  if (unit !== 'toman' && unit !== 'rial') return null;
  // rial = toman × 10
  const rialNum = unit === 'rial' ? BigInt(digits) : BigInt(digits) * RIAL_PER_TOMAN;
  const rialDen = scale;
  if (rialDen === 0n) return null;
  if (rialNum % rialDen !== 0n) return null; // would produce sub-rial fraction
  let rial = Number(rialNum / rialDen);
  if (negative) rial = -rial;
  if (!Number.isSafeInteger(rial) || Math.abs(rial) > MAX_ABS_RIAL) return null;
  return rial;
}

/** Parse a quantity into thousandths (e.g. "2" → 2000, "0.25" → 250). */
export function parseQtyX1000(raw, { allowNegative = false, max = 1_000_000_000 } = {}) {
  const s = normalizeDigits(raw);
  if (!/^-?\d+(\.\d{1,3})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  const value = Number(intPart) * QTY_SCALE + Number((fracPart + '000').slice(0, 3));
  if (!Number.isSafeInteger(value)) return null;
  const out = negative ? -value : value;
  if (!allowNegative && out < 0) return null;
  if (Math.abs(out) > max) return null;
  return out;
}

/** Parse a percent ("3.5" → 350). */
export function parsePctX100(raw, { allowNegative = true, max = 1_000_000_000 } = {}) {
  const s = normalizeDigits(raw);
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [intPart, fracPart = ''] = (negative ? s.slice(1) : s).split('.');
  const value = Number(intPart) * 100 + Number((fracPart + '00').slice(0, 2));
  const out = negative ? -value : value;
  if (!allowNegative && out < 0) return null;
  if (Math.abs(out) > max) return null;
  return out;
}

/** Round-half-away-from-zero integer division on BigInts (never banker's rounding). */
export function divRound(num, den) {
  const n = BigInt(num);
  const d = BigInt(den);
  if (d === 0n) throw new Error('division by zero');
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const r = an % ad;
  const out = r * 2n >= ad ? q + 1n : q;
  return neg ? -out : out;
}

/** (a * b) / c with round-half-away-from-zero, using BigInt throughout. */
export function mulDiv(a, b, c) {
  return divRound(BigInt(a) * BigInt(b), BigInt(c));
}

/** Exact sum of whole-rial integers (BigInt accumulation, safe conversion back). */
export function sumInt(values, field) {
  let acc = 0n;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'bigint') {
      acc += v;
      continue;
    }
    if (!Number.isSafeInteger(v)) {
      throw new TypeError(`non-integer money value in ${field ?? 'amount'}: ${v}`);
    }
    acc += BigInt(v);
  }
  const n = Number(acc);
  if (!Number.isSafeInteger(n)) throw new RangeError(`overflow while summing ${field ?? 'amounts'}`);
  return n;
}

export const sum = (values, field) => sumInt(values, field);

export function safeAdd(a, b, field) {
  const n = Number(BigInt(a) + BigInt(b));
  if (!Number.isSafeInteger(n)) throw new RangeError(`overflow in ${field ?? 'sum'}`);
  return n;
}

/** Integer rial → numeric toman (may be x.5 for odd rial). Use only for display/export. */
export function rialToToman(rial) {
  return Number(BigInt(rial)) / 10;
}

/** Format rial for Persian display: grouping + Persian digits, unit label appended. */
export function formatRial(rial, { unit = 'toman', digits = 'fa', sign = 'auto' } = {}) {
  const value = Math.trunc(Number(rial) || 0);
  // divRound keeps the half-away-from-zero rule; Number() because the display
  // layer must never hand a BigInt to Math/String.
  const shown = unit === 'rial' ? value : Number(divRound(value, 10));
  let s = String(Math.abs(shown)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  if (digits === 'en') s = s.replace(/٬/g, ',');
  if (sign === 'auto' && value < 0) s = '−' + s;
  else if (sign === 'negative' && value < 0) s = `(${s})`;
  if (digits === 'fa') s = s.replace(/\d/g, (d) => FA_DIGITS[+d]);
  const unitLabel = unit === 'rial' ? 'ریال' : 'تومان';
  return `${s} ${unitLabel}`;
}

export function formatQty(qtyX1000, { digits = 'fa' } = {}) {
  const v = Number(qtyX1000) / QTY_SCALE;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (digits === 'en') return s;
  return s.replace(/\./g, '٫').replace(/\d/g, (d) => FA_DIGITS[+d]);
}

export function formatPct(pctX100, { digits = 'fa', signed = true } = {}) {
  const v = Number(pctX100) / 100;
  const body = Math.abs(v).toFixed(2).replace(/\.?0+$/, '');
  let s = (v < 0 ? '−' : signed ? '+' : '') + body;
  if (digits === 'fa') s = s.replace(/\./g, '٫').replace(/\d/g, (d) => FA_DIGITS[+d]);
  return `${s}٪`;
}

/** Convert any integer-ish payload to Latin-digit string for JSON transport. */
export function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
