// Hyper Sina — dependency-free SVG charts (RTL-friendly, print-safe).
import { group, toFa, el } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
};

const fmtShort = (v) => {
  const a = Math.abs(v);
  if (a >= 1e12) return toFa((v / 1e12).toFixed(1).replace(/\.0$/, '')) + 'هزارمیلیارد';
  if (a >= 1e9) return toFa((v / 1e9).toFixed(1).replace(/\.0$/, '')) + 'میلیارد';
  if (a >= 1e6) return toFa((v / 1e6).toFixed(1).replace(/\.0$/, '')) + 'میلیون';
  if (a >= 1e3) return toFa(String(Math.round(v / 1e3))) + 'هزار';
  return toFa(String(Math.round(v)));
};

/**
 * Bars for one series (positive/negative aware) with an optional second line.
 * items: [{label, value, secondary?}]
 */
export function barChart(items, { height = 168, format = fmtShort, line = true, lineLabel = '' } = {}) {
  const svg = mk('svg', { class: 'chart', viewBox: `0 0 ${Math.max(items.length * 52, 320)} ${height + 46}`, role: 'img' });
  const w = Number(svg.getAttribute('viewBox').split(' ')[2]);
  const padB = 34;
  const plotH = height;
  const values = items.map((i) => i.value);
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));
  const top = maxAbs;
  const zero = plotH / 2;
  const scale = (v) => zero - (v / maxAbs) * (plotH / 2 - 8);
  mk('line', { class: 'grid-line', x1: 0, x2: w, y1: zero, y2: zero }, svg);
  const bw = Math.max(10, (w - 12) / Math.max(items.length, 1) - 12);
  items.forEach((it, idx) => {
    const x = 6 + idx * ((w - 12) / Math.max(items.length, 1));
    const y = Math.min(scale(it.value), zero);
    const h = Math.max(2, Math.abs(scale(it.value) - zero));
    const bar = mk('rect', { class: `bar ${it.value < 0 ? 'neg' : ''}`, x, y, width: bw, height: h, rx: 4 }, svg);
    bar.appendChild(mk('title', {}, bar)).textContent = `${it.label}: ${group(Math.round(it.value))}`;
    const t = mk('text', { class: 'axis-text', x: x + bw / 2, y: height + 14, 'text-anchor': 'middle' }, svg);
    t.textContent = it.shortLabel || it.label;
    if (it.value !== 0) {
      const vt = mk('text', { class: 'axis-text', x: x + bw / 2, y: it.value >= 0 ? y - 4 : y + h + 9, 'text-anchor': 'middle' }, svg);
      vt.textContent = format(it.value);
    }
  });
  if (line && items.some((i) => i.secondary !== undefined && i.secondary !== null)) {
    const pts = items
      .map((it, idx) => {
        if (it.secondary === null || it.secondary === undefined) return null;
        const x = 6 + idx * ((w - 12) / Math.max(items.length, 1)) + bw / 2;
        const y = scale(it.secondary);
        return `${x},${y}`;
      })
      .filter(Boolean);
    if (pts.length > 1) mk('polyline', { class: 'line alt', points: pts.join(' '), 'stroke-width': 2 }, svg);
    pts.forEach((p) => {
      const [x, y] = p.split(',');
      mk('circle', { cx: x, cy: y, r: 3, fill: '#b5851f' }, svg);
    });
  }
  if (lineLabel) {
    const lg = mk('g', {}, svg);
    mk('rect', { x: w - 120, y: height + 26, width: 10, height: 3, rx: 1.5, fill: '#b5851f' }, lg);
    const t = mk('text', { class: 'axis-text', x: w - 105, y: height + 32 }, lg);
    t.textContent = lineLabel;
  }
  return svg;
}

/** Single-series line + area chart (used for the USD rate history). */
export function lineChart(points, { height = 150, showValues = true, labelEvery = 1, format = fmtShort } = {}) {
  const svg = mk('svg', { class: 'chart', viewBox: `0 0 ${Math.max(points.length * 40, 320)} ${height + 40}`, role: 'img' });
  const w = Number(svg.getAttribute('viewBox').split(' ')[2]);
  const padX = 8;
  const ys = points.map((p) => p.value);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || Math.abs(max) || 1;
  const n = Math.max(points.length - 1, 1);
  const px = (i) => padX + (i / n) * (w - padX * 2);
  const py = (v) => 12 + (1 - (v - min) / span) * (height - 34);
  for (let g = 0; g <= 2; g += 1) {
    const y = 12 + (g / 2) * (height - 34);
    mk('line', { class: 'grid-line', x1: 0, x2: w, y1: y, y2: y }, svg);
    const t = mk('text', { class: 'axis-text', x: w - 2, y: y - 3, 'text-anchor': 'end' }, svg);
    t.textContent = format(max - (g / 2) * span);
  }
  const pts = points.map((p, i) => `${px(i)},${py(p.value)}`);
  mk('polygon', { class: 'area', points: `${padX},${height - 22} ${pts.join(' ')} ${px(points.length - 1)},${height - 22}` }, svg);
  mk('polyline', { class: 'line', points: pts.join(' ') }, svg);
  points.forEach((p, i) => {
    const c = mk('circle', { class: 'dot', cx: px(i), cy: py(p.value), r: 3.2 }, svg);
    c.appendChild(mk('title', {}, c)).textContent = `${p.label}: ${group(Math.round(p.value))}`;
    if (i % labelEvery === 0) {
      const t = mk('text', { class: 'axis-text', x: px(i), y: height + 12, 'text-anchor': 'middle' }, svg);
      t.textContent = p.shortLabel || p.label;
    }
  });
  return svg;
}

/** Horizontal breakdown bars (expense categories etc.) */
export function breakdown(rows, { format = (v) => group(v) } = {}) {
  const host = document.createElement('div');
  host.className = 'grid';
  host.style.gap = '8px';
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const safeColor = (c) => (typeof c === 'string' && /^(#[0-9a-f]{3,8}|[a-z]{3,12}|var\(--[a-z0-9-]+\))$/i.test(c) ? c : 'var(--brand-2)');
  for (const r of rows) {
    const w = Math.max(1.5, (Math.abs(r.value) / max) * 100);
    const fill = el('div', { style: `height:100%;width:${w}%;background:${safeColor(r.color)};border-radius:6px` });
    const track = el('div', { style: 'height:8px;background:#eef1f4;border-radius:6px;overflow:hidden;margin-top:3px' }, [fill]);
    host.appendChild(
      el('div', { title: r.title || undefined }, [
        el('div', { style: 'display:flex;justify-content:space-between;gap:8px;font-size:12.5px' }, [
          el('span', { text: r.label }),
          el('b', { style: 'font-variant-numeric:tabular-nums' }, [String(format(r.value)), ...(r.pct ? [el('span', { class: 'hint', text: ` ${r.pct}` })] : [])]),
        ]),
        track,
      ]),
    );
  }
  return host;
}
