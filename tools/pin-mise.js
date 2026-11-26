#!/usr/bin/env node
// Pin a new mise release everywhere the engine pins it (D94): the `version:` line of every jdx/mise-action step in
// .github/workflows/*.yml, and test/containers/matrix.json (the version the Linux test images install, with the sha256
// of its linux-arm64 and linux-x64 tarballs). Renovate moves the workflow pins but can't compute the checksums, so a
// mise bump failed `test/linux-test.test.js` until someone wrote them by hand. The checksums come from the release's own
// SHASUMS256.txt, never from a download that this script hashes itself.
// Usage: pin-mise.js <version> [--check]     (--check changes nothing: it says what would change, and exits 1 if anything would)
//        pin-mise.js <version> --sums <file> reads SHASUMS256.txt from a file instead of GitHub (a test, or an offline run)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const MATRIX = path.join(ROOT, 'test', 'containers', 'matrix.json');
const VERSION = /^\d{4}\.\d+\.\d+$/;
// the step's `version: 2026.11.8` line, as test/linux-test.test.js reads it
const PIN = /^(\s+version: )(\d{4}\.\d+\.\d+)(\s*)$/gm;
const ARCHES = { arm64: 'linux-arm64', x64: 'linux-x64' };

// parseSums(text, version) — { arm64, x64 }: the sha256 of mise-v<version>-linux-<arch>.tar.gz in a SHASUMS256.txt.
// Throws when either is missing or isn't 64 hex characters
function parseSums(text, version) {
  const out = {};
  for (const [arch, suffix] of Object.entries(ARCHES)) {
    const file = `mise-v${version}-${suffix}.tar.gz`;
    const line = text.split('\n').map(l => l.trim().split(/\s+/)).find(f => f.length === 2 && f[1].replace(/^\.\//, '').replace(/^\*/, '') === file);
    if (!line || !/^[0-9a-f]{64}$/.test(line[0])) throw new Error(`no sha256 for ${file} in the release's SHASUMS256.txt`);
    out[arch] = line[0];
  }
  return out;
}

// pinWorkflow(text, version) — { text, changed }: every mise pin in a workflow moved to the version
function pinWorkflow(text, version) {
  let changed = 0;
  const out = text.replace(PIN, (_m, pre, v, post) => { if (v !== version) changed++; return `${pre}${version}${post}`; });
  return { text: out, changed };
}

// pinMatrix(text, version, sums) — { text, changed }: matrix.json's mise block with the version and checksums. The
// file's own formatting is kept: only the block's values are replaced
function pinMatrix(text, version, sums) {
  const m = JSON.parse(text);
  if (!m.mise || !m.mise.sha256) throw new Error('matrix.json has no mise block');
  const same = m.mise.version === version && m.mise.sha256.arm64 === sums.arm64 && m.mise.sha256.x64 === sums.x64;
  m.mise = { ...m.mise, version, sha256: { ...m.mise.sha256, arm64: sums.arm64, x64: sums.x64 } };
  const out = `${JSON.stringify(m, null, 2)}\n`;
  // the file must round-trip through JSON.stringify unchanged, or this would rewrite more than the mise block
  if (JSON.stringify(JSON.parse(text), null, 2) + '\n' !== text) throw new Error('matrix.json is not formatted as JSON.stringify writes it (2 spaces); refusing to rewrite it');
  return { text: out, changed: same ? 0 : 1 };
}

// sumsFromGitHub(version) — the release's SHASUMS256.txt, fetched over HTTPS
async function sumsFromGitHub(version) {
  const url = `https://github.com/jdx/mise/releases/download/v${version}/SHASUMS256.txt`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// run(argv, io) — 0 = done (or nothing to change), 1 = --check found something to change, 2 = a usage or fetch error
async function run(argv, io = {}) {
  const log = io.log || console.log;
  const err = io.err || console.error;
  const dir = io.workflows || WORKFLOWS;
  const matrix = io.matrix || MATRIX;
  const args = argv.filter(a => !a.startsWith('--'));
  const check = argv.includes('--check');
  const sumsAt = argv.indexOf('--sums');
  const sumsFile = sumsAt >= 0 ? argv[sumsAt + 1] : '';
  const version = args.find(a => VERSION.test(a));
  if (!version) { err('usage: pin-mise.js <version, e.g. 2026.11.12> [--check] [--sums <SHASUMS256.txt>]'); return 2; }
  let sums;
  try { sums = parseSums(sumsFile ? fs.readFileSync(sumsFile, 'utf8') : await (io.fetchSums || sumsFromGitHub)(version), version); }
  catch (e) { err(`pin-mise: ${e.message}`); return 2; }
  const writes = [];
  for (const f of fs.readdirSync(dir).filter(n => /\.ya?ml$/.test(n)).sort()) {
    const p = path.join(dir, f);
    const r = pinWorkflow(fs.readFileSync(p, 'utf8'), version);
    if (r.changed) writes.push({ p, text: r.text, what: `${f}: ${r.changed} pin(s)` });
  }
  let mt;
  try { mt = pinMatrix(fs.readFileSync(matrix, 'utf8'), version, sums); } catch (e) { err(`pin-mise: ${e.message}`); return 2; }
  if (mt.changed) writes.push({ p: matrix, text: mt.text, what: `${path.relative(ROOT, matrix)}: version and checksums` });
  if (!writes.length) { log(`mise ${version} is already pinned everywhere`); return 0; }
  for (const w of writes) log(`${check ? 'would change' : 'changed'}  ${w.what}`);
  if (check) return 1;
  for (const w of writes) fs.writeFileSync(w.p, w.text);
  log(`pinned mise ${version}; run: just test`);
  return 0;
}

module.exports = { parseSums, pinWorkflow, pinMatrix, run };

if (require.main === module) run(process.argv.slice(2)).then(c => process.exit(c));
