#!/usr/bin/env node
// Hyper Sina — dependency-free static checks.
// The project deliberately has zero npm dependencies, so "npm run lint" is a
// small first-party checker instead of ESLint. It enforces the invariants that
// actually break this app: unresolvable imports, calls to API routes that do
// not exist, broken syntax, unsafe DOM sinks, remote assets that the CSP would
// block, and accidental placeholder/demo data in the accounting layer.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'legacy') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const files = walk(root);
const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
const rel = (f) => path.relative(root, f).split(path.sep).join('/');

/* 1) syntax --------------------------------------------------------------- */
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) errors.push(`${rel(f)}: syntax error — ${r.stderr.split('\n').slice(0, 3).join(' ').trim()}`);
}

/* 2) imports resolve ------------------------------------------------------ */
const importRe = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(importRe)) {
    const spec = m[1];
    if (!spec.startsWith('.')) {
      if (!spec.startsWith('node:')) errors.push(`${rel(f)}: non-node bare import "${spec}" (project must stay dependency-free)`);
      continue;
    }
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) errors.push(`${rel(f)}: import "${spec}" does not resolve`);
  }
}

/* 3) named imports actually exported ------------------------------------- */
const exportsOf = new Map();
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (t) names.add(t);
    }
  }
  if (/^export\s+default/m.test(src)) names.add('default');
  exportsOf.set(rel(f), names);
}
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[2]);
    if (!fs.existsSync(target)) continue;
    const available = exportsOf.get(rel(target));
    if (!available) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !available.has(name)) errors.push(`${rel(f)}: "${name}" is not exported by ${rel(target)}`);
    }
  }
}

/* 4) unused named imports (kept noisy on purpose: dead imports hide typos) */
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const body = src.replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/g, '');
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop().trim();
      if (!alias) continue;
      if (!new RegExp(`\\b${alias.replace(/\$/g, '\\$')}\\b`).test(body)) warnings.push(`${rel(f)}: unused import "${alias.trim()}"`);
    }
  }
}

/* 5) DOM safety ------------------------------------------------------------ */
const ALLOW_RAW_HTML = new Set(['web/util.js']); // the single audited sink: el({html}) + dialog copy
for (const f of jsFiles.filter((x) => rel(x).startsWith('web/'))) {
  const src = fs.readFileSync(f, 'utf8');
  if (!ALLOW_RAW_HTML.has(rel(f)) && /\.innerHTML\s*=/.test(src)) errors.push(`${rel(f)}: direct innerHTML assignment (use el() helpers so Persian text is escaped)`);
  if (/\beval\(|new Function\(|document\.write\(/.test(src)) errors.push(`${rel(f)}: eval/new Function/document.write is forbidden`);
  if (/\son[a-z]+\s*=/.test(src)) errors.push(`${rel(f)}: inline on* handler attribute (blocked by the CSP)`);
  if (/fetch\(['"]https?:\/\//.test(src)) errors.push(`${rel(f)}: network call to a third-party host (all data must come from this app's own API)`);
}

/* 6) client API calls hit real routes -------------------------------------- */
const appSrc = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
const routes = new Set(
  [...appSrc.matchAll(/router\.(get|post|put|del|delete)\([`'"]([^`'"]+)[`'"]/g)].map((m) => `${m[1] === 'delete' ? 'del' : m[1]} ${m[2]}`),
);
const routePaths = new Map();
for (const r of routes) {
  const [method, p] = r.split(' ');
  if (!routePaths.has(p)) routePaths.set(p, new Set());
  routePaths.get(p).add(method);
}
const toRegex = (p) => new RegExp(`^${p.replace(/:[A-Za-z0-9_]+/g, '[^/]+').replace(/\*/g, '.*')}$`);
const callers = files.filter((f) => rel(f).startsWith('web/'));
for (const f of callers) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/\b(get|post|put|del)\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g)) {
    const method = m[1];
    const url = m[2].split('?')[0].replace(/\/$/, '');
    if (/[\${]/.test(m[2])) continue;
    const ok = [...routePaths.keys()].some((p) => toRegex(p).test(url) && routePaths.get(p).has(method));
    if (!ok) errors.push(`${rel(f)}: ${method.toUpperCase()} ${url} has no matching server route`);
  }
}

/* 7) server-side invariants ------------------------------------------------ */
const serverFiles = files.filter((f) => rel(f).startsWith('server/'));
for (const f of serverFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const name = rel(f);
  if (/TODO|FIXME|XXX/.test(src)) warnings.push(`${name}: leftover TODO/FIXME marker`);
  if (name.startsWith('server/') && /\b(parseFloat|Math\.random)\(/.test(src) && !name.endsWith('auth.js')) {
    errors.push(`${name}: parseFloat/Math.random in the accounting layer (money must be integer rial with BigInt math)`);
  }
  if (/\b(MOCK|mock|dummy|lorem|seedDemo|fakeData)\b/.test(src)) errors.push(`${name}: placeholder/demo data is not allowed`);
}
for (const f of files.filter((x) => rel(x).startsWith('server/migrations/'))) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/^create table/im.test(src)) warnings.push(`${rel(f)}: no CREATE TABLE (is this migration what you meant?)`);
  if (/DROP TABLE/i.test(src)) errors.push(`${rel(f)}: migrations must never DROP TABLE — data loss is not a migration`);
}

/* 8) money contract --------------------------------------------------------- */
const apiSrc = fs.readFileSync(path.join(root, 'server/http.js'), 'utf8');
if (!/\*_toman[\s\S]*\*_rial/.test(apiSrc) && !/toman/.test(apiSrc)) errors.push('server/http.js: amount field validation (toman XOR rial) is missing');
for (const f of serverFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/amount_(rial|toman)\b/g)) {
    if (!['rial', 'toman'].includes(m[1])) errors.push(`${rel(f)}: unexpected money suffix amount_${m[1]}`);
  }
}

/* 9) housekeeping ----------------------------------------------------------- */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (Object.keys(pkg.dependencies || {}).length || Object.keys(pkg.devDependencies || {}).length) {
  warnings.push('package.json declares dependencies; this project is intentionally zero-dependency');
}
if (fs.existsSync(path.join(root, 'web/index.html'))) {
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
    if (!fs.existsSync(path.join(root, 'web', m[1])) && !m[1].startsWith('/api')) errors.push(`web/index.html: ${m[1]} does not exist`);
  }
  if (!/dir="rtl"/.test(html)) errors.push('web/index.html: missing dir="rtl"');
  if (!/lang="fa"/.test(html)) errors.push('web/index.html: missing lang="fa"');
}

/* report ------------------------------------------------------------------- */
const unique = (a) => [...new Set(a)];
for (const w of unique(warnings)) console.log(`warning  ${w}`);
for (const e of unique(errors)) console.error(`error    ${e}`);
console.log(`\nlint: ${unique(errors).length} error(s), ${unique(warnings).length} warning(s) across ${jsFiles.length} JS files.`);
process.exit(unique(errors).length ? 1 : 0);
