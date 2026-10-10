#!/usr/bin/env node
// Hyper Sina — build step.
// The app ships as plain ES modules with a zero-dependency server, so "build"
// means: verify every module parses, copy the client + server sources into a
// deployable `dist/`, and emit an integrity manifest (sha256 + byte size per
// file) so a deployment can be compared against the source tree. No bundler, no
// minifier, no transpiler — deliberately: the code must run as written.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const INCLUDE_DIRS = ['server', 'web'];
const INCLUDE_FILES = ['package.json', 'vercel.json', 'api/index.js'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'legacy', '.vercel']);
const ASSET_CACHE = { web: 'public, max-age=300, must-revalidate' };

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const files = [];
for (const d of INCLUDE_DIRS) {
  const abs = path.join(root, d);
  if (!fs.existsSync(abs)) {
    console.error(`build: missing required directory ${d}/`);
    process.exit(1);
  }
  for (const f of walk(abs)) files.push(f);
}
for (const f of INCLUDE_FILES) {
  const abs = path.join(root, f);
  if (fs.existsSync(abs)) files.push(abs);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const manifest = { app: 'hyper-sina', built_at: new Date().toISOString(), node: process.version, files: [] };
let failures = 0;

for (const src of files.sort()) {
  const rel = path.relative(root, src).split(path.sep).join('/');
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = fs.readFileSync(src);

  // Every module must at least parse on the target runtime.
  if (rel.endsWith('.js')) {
    const check = spawnSync(process.execPath, ['--check', src], { encoding: 'utf8' });
    if (check.status !== 0) {
      console.error(`build: ${rel} failed to parse\n${check.stderr}`);
      failures += 1;
      continue;
    }
  }

  fs.writeFileSync(dest, buf);
  const entry = { path: rel, bytes: buf.length, sha256: sha256(buf) };
  for (const [dir, cache] of Object.entries(ASSET_CACHE)) {
    if (rel.startsWith(dir + '/')) entry.cache = cache;
  }
  manifest.files.push(entry);
}

// Migrations are checksummed so a deploy can prove it runs the same schema set.
const migDir = path.join(out, 'server/migrations');
if (fs.existsSync(migDir)) {
  manifest.migrations = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sha256: sha256(fs.readFileSync(path.join(migDir, f))) }));
}

const total = manifest.files.reduce((a, f) => a + f.bytes, 0);
fs.writeFileSync(path.join(out, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(
  path.join(out, 'BUILD.txt'),
  `Hyper Sina build\nfiles: ${manifest.files.length}\nbytes: ${total}\nbuilt_at: ${manifest.built_at}\nnode: ${manifest.node}\n\nDeploy notes:\n- Vercel: framework "Other", build command "node scripts/build.js", output directory not used;\n  the API function is api/index.js and it serves dist/web + web/ from the same module.\n- Long-lived Node: node server/index.js  (PORT, HYPER_SINA_DB, HYPER_SINA_SESSION_SECRET)\n- SQLite needs a writable disk. On serverless, mount a persistent volume or point\n  HYPER_SINA_DB at an attached disk; otherwise the app boots read-only and refuses writes.\n`,
);

if (failures) {
  console.error(`build: FAILED (${failures} file(s) did not parse)`);
  process.exit(1);
}
console.log(`build: ${manifest.files.length} files, ${(total / 1024).toFixed(1)} KiB → dist/`);
console.log(`build: ${manifest.migrations?.length ?? 0} migration(s) fingerprinted`);
console.log('build: ok');
