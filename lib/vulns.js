// Known vulnerabilities in what the steward installs (D65): `steward sc vulns`, and the audit's `vulns` check. Read-only.
// Two halves:
//   inventory(ctx) — every installed package with an advisory ecosystem: mise's npm, pipx, cargo and go tools (with
//     the packages inside an npm or pipx tool), the npm -g hybrids in the active Node with theirs, and Node itself; and
//     the tools with no ecosystem, which are reported as not covered, never as clean.
//   lookup(ctx, feeds, inv) — the advisories that affect them, from the feeds host.toml [[advisory_feed]] declares
//     (the engine's defaults: osv, nodejs, kev). A feed is data, never code (the owner's decision 4, 2026-11-02):
//       osv-api  a server that speaks OSV's API (/v1/querybatch, /v1/vulns/<id>): api.osv.dev, which carries the
//                GitHub Advisory Database for npm, PyPI, crates.io and Go, or a mirror
//       osv-dir  a folder of OSV-format JSON records in the instance (advisories no database carries yet)
//       nodejs   nodejs.org's release index: a newer release on the active line marked security
//       kev      CISA's Known Exploited Vulnerabilities catalog: marks a finding whose CVE is being exploited
//     A feed that can't be read is reported as not checked, never as clean.
// Every network call goes through ctx.run (curl), so tests hand it canned answers.
const fs = require('fs');
const path = require('path');

const FEED_KINDS = ['osv-api', 'osv-dir', 'nodejs', 'kev'];
const SEVERITIES = ['low', 'moderate', 'high', 'critical'];
const RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

// SETTINGS — host.toml [vulns], each with its default (the engine's host-defaults.toml shows them too). What makes a
// finding an action, what is looked at, and how hard the feeds are asked
const SETTINGS = {
  action_severity: 'high',          // a finding at or above this is an action (review and brief list it); below, info
  unrated: 'high',                  // the severity a finding nobody rated counts as (not a quiet one by default)
  exploited_always_action: true,    // a finding in CISA's KEV catalog is an action whatever its severity
  inside_tools: true,               // also check the packages inside an npm or pipx tool and inside each hybrid
  hybrids: true,                    // check the npm -g hybrids in the active Node
  list_not_covered: true,           // list the tools no feed can check (not covered is not clean)
  batch_size: 500,                  // queries per OSV querybatch request (OSV's limit is 1000)
  parallel: 8,                      // advisory records fetched at once
  timeout_seconds: 60,              // each request to a feed
};
const LIMITS = { batch_size: [1, 1000], parallel: [1, 32], timeout_seconds: [5, 600] };

// settings(given) — {values, problems}: host.toml [vulns] over SETTINGS; a value of the wrong kind keeps the default
function settings(given = {}) {
  const values = { ...SETTINGS }, problems = [];
  for (const [k, v] of Object.entries(given || {})) {
    if (k === '_source') continue;
    if (!(k in SETTINGS)) { problems.push(`unknown key ${k} (${Object.keys(SETTINGS).join(', ')})`); continue; }
    const d = SETTINGS[k];
    if (typeof d === 'string' && !SEVERITIES.includes(v)) problems.push(`${k} must be ${SEVERITIES.join(', ')}`);
    else if (typeof d === 'boolean' && typeof v !== 'boolean') problems.push(`${k} must be true or false`);
    else if (typeof d === 'number' && !(Number.isInteger(v) && v >= LIMITS[k][0] && v <= LIMITS[k][1])) problems.push(`${k} must be a whole number from ${LIMITS[k][0]} to ${LIMITS[k][1]}`);
    else values[k] = v;
  }
  return { values, problems };
}
// rank(severity, s) — a severity's rank, an unrated one at s.unrated's
const rank = (sev, s = SETTINGS) => RANK[sev === 'unknown' ? s.unrated : sev] || 0;

// ecosystemOf(tool) — {ecosystem, name} for a mise tool key ('npm:renovate', 'pipx:black', 'cargo:ripgrep',
// 'go:github.com/x/y/cmd/z'), or null when its backend has no advisory ecosystem (core, aqua, github, asdf, vfox…)
function ecosystemOf(tool) {
  const i = tool.indexOf(':');
  if (i < 0) return null;
  const backend = tool.slice(0, i), name = tool.slice(i + 1).replace(/@[^/]*$/, '');
  if (backend === 'npm') return { ecosystem: 'npm', name };
  if (backend === 'pipx' || backend === 'pypi') return { ecosystem: 'PyPI', name };
  if (backend === 'cargo') return { ecosystem: 'crates.io', name };
  // Go advisories name the module; a tool installed from a command path names its module up to /cmd/
  if (backend === 'go') return { ecosystem: 'Go', name: name.replace(/\/cmd\/.*$/, '') };
  return null;
}

// lockPackages(file, text) — [{name, version}] from an npm tool's lockfile: aube-lock.yaml or pnpm-lock.yaml (the
// `packages:` keys, 'name@version'), or package-lock.json (v2/v3 `packages`, keyed by node_modules path)
function lockPackages(file, text) {
  const out = [];
  if (file.endsWith('.json')) {
    const j = JSON.parse(text);
    for (const [k, v] of Object.entries(j.packages || {})) {
      if (!k || !v || !v.version || v.link) continue;
      out.push({ name: v.name || k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length), version: v.version });
    }
    return out;
  }
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) { inPackages = /^packages:\s*$/.test(line); continue; }
    if (!inPackages) continue;
    const m = line.match(/^ {2}'?(@?[^@\s'(]+)@([^@\s'():]+)(?:\(|'|:)/);
    if (m) out.push({ name: m[1], version: m[2] });
  }
  return out;
}

// walkNodeModules(dir) — [{name, version}] for every package under dir/node_modules, nested ones too (npm -g installs
// keep no lockfile). Symbolic links are not followed, so a link loop can't trap it
function walkNodeModules(dir, out = []) {
  const nm = path.join(dir, 'node_modules');
  let entries = [];
  try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch { return out; }
  const pkg = d => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
      if (j.name && j.version) out.push({ name: j.name, version: j.version });
    } catch { /* not a package */ }
    walkNodeModules(d, out);
  };
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      let scoped = [];
      try { scoped = fs.readdirSync(path.join(nm, e.name), { withFileTypes: true }); } catch { /* unreadable */ }
      for (const s of scoped) if (s.isDirectory()) pkg(path.join(nm, e.name, s.name));
    } else pkg(path.join(nm, e.name));
  }
  return out;
}

// npmTree(dir) — the packages an npm tool's install folder holds: its lockfile when it has one, else its node_modules
function npmTree(dir) {
  for (const f of ['aube-lock.yaml', 'pnpm-lock.yaml', 'package-lock.json', path.join('node_modules', '.package-lock.json')]) {
    const p = path.join(dir, f);
    try { return lockPackages(p, fs.readFileSync(p, 'utf8')); } catch { /* absent or unreadable: the next */ }
  }
  return walkNodeModules(dir);
}

// sitePackages(dir) — [{name, version}] from the *.dist-info folders of a Python install (a pipx tool's venv)
function sitePackages(dir) {
  const out = [];
  const visit = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^(.+)-([^-]+)\.dist-info$/);
      if (m) out.push({ name: m[1].replace(/_/g, '-'), version: m[2] });
      else if (depth < 5) visit(path.join(d, e.name), depth + 1);
    }
  };
  visit(dir, 0);
  return out;
}

// inventory(ctx, s) — {packages: [{ecosystem, name, version, tool, top}], node, covered: [tool], uncovered: [tool]}.
// tool: the mise tool or 'npm -g <name>' that holds the package; top: the package is that tool itself. s: settings()
// values (inside_tools: the packages inside a tool too; hybrids: the npm -g hybrids)
async function inventory(ctx, s = SETTINGS) {
  const r = await ctx.run('mise', ['ls', '--json']);
  if (r.status !== 0) throw new Error('mise ls --json failed');
  const tools = JSON.parse(r.stdout || '{}');
  const packages = [], covered = [], uncovered = [];
  let node = null;
  const add = (ecosystem, list, tool, topName) => {
    for (const p of list) if (s.inside_tools || p.name === topName) packages.push({ ecosystem, name: p.name, version: p.version, tool, top: p.name === topName });
  };
  for (const [tool, installs] of Object.entries(tools)) {
    const active = (installs || []).filter(i => i.active);
    const use = active.length ? active : (installs || []).filter(i => i.installed);
    for (const i of use) {
      if (tool === 'node') { node = { version: i.version, dir: i.install_path }; covered.push(tool); continue; }
      const eco = ecosystemOf(tool);
      if (!eco) { uncovered.push(tool); continue; }
      covered.push(tool);
      const top = [{ name: eco.name, version: i.version }];
      if (eco.ecosystem === 'npm') {
        const tree = s.inside_tools ? npmTree(i.install_path) : [];
        add('npm', tree.some(p => p.name === eco.name) ? tree : [...top, ...tree], tool, eco.name);
      } else if (eco.ecosystem === 'PyPI') {
        const tree = s.inside_tools ? sitePackages(i.install_path) : [];
        add('PyPI', tree.some(p => p.name.toLowerCase() === eco.name.toLowerCase()) ? tree : [...top, ...tree], tool, eco.name);
      } else add(eco.ecosystem, [{ name: eco.name, version: String(i.version).replace(/^v/, '') }], tool, eco.name);
    }
  }
  // the npm -g hybrids in the active Node, each with the packages inside it
  if (node && s.hybrids) {
    const g = path.join(node.dir, 'lib', 'node_modules');
    let names = [];
    try { names = fs.readdirSync(g, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name); } catch { /* none */ }
    for (const n of names.flatMap(n => (n.startsWith('@') ? fs.readdirSync(path.join(g, n)).map(s => `${n}/${s}`) : [n]))) {
      const dir = path.join(g, n);
      let self = null;
      try { self = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
      add('npm', [{ name: self.name, version: self.version }, ...(s.inside_tools ? walkNodeModules(dir) : [])], `npm -g ${self.name}`, self.name);
      covered.push(`npm -g ${self.name}`);
    }
  }
  return { packages: dedupe(packages), node: node && node.version, covered: [...new Set(covered)], uncovered: [...new Set(uncovered)] };
}

// dedupe(packages) — one entry per ecosystem, name, version and tool
function dedupe(packages) {
  const seen = new Set();
  return packages.filter(p => { const k = `${p.ecosystem}\0${p.name}\0${p.version}\0${p.tool}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// cmpVer(a, b) — negative, 0 or positive as version a sorts before, with or after b: runs of digits compare as numbers,
// and a pre-release (1.2.0-rc.1) sorts before its release
function cmpVer(a, b) {
  const [x, xp] = String(a).replace(/^v/, '').split(/-(.*)/s), [y, yp] = String(b).replace(/^v/, '').split(/-(.*)/s);
  const parts = s => String(s).split(/[.+]/).map(p => (/^\d+$/.test(p) ? Number(p) : p));
  const px = parts(x), py = parts(y);
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    const u = px[i] ?? 0, v = py[i] ?? 0;
    if (u === v) continue;
    if (typeof u === 'number' && typeof v === 'number') return u - v;
    return String(u) < String(v) ? -1 : 1;
  }
  if (xp && !yp) return -1;
  if (yp && !xp) return 1;
  return xp && yp ? (xp < yp ? -1 : xp > yp ? 1 : 0) : 0;
}

// samePackage(affected, eco, name) — whether an OSV `affected` entry is about this package (PyPI names compare as PEP 503
// normalizes them)
const norm = (eco, n) => (eco === 'PyPI' ? String(n).toLowerCase().replace(/[-_.]+/g, '-') : String(n));
const samePackage = (a, eco, name) => a && a.package && a.package.ecosystem === eco && norm(eco, a.package.name) === norm(eco, name);

// affects(record, eco, name, version) — whether an OSV record says this version is affected: listed in `versions`, or
// inside a SEMVER or ECOSYSTEM range (introduced … fixed, exclusive, or … last_affected, inclusive)
function affects(record, eco, name, version) {
  for (const a of (record.affected || []).filter(x => samePackage(x, eco, name))) {
    if ((a.versions || []).includes(version)) return true;
    for (const r of a.ranges || []) {
      if (r.type === 'GIT') continue;
      let from = null;
      for (const e of r.events || []) {
        if ('introduced' in e) from = e.introduced;
        else if (from !== null && ('fixed' in e || 'last_affected' in e)) {
          const inFrom = from === '0' || cmpVer(version, from) >= 0;
          const inTo = 'fixed' in e ? cmpVer(version, e.fixed) < 0 : cmpVer(version, e.last_affected) <= 0;
          if (inFrom && inTo) return true;
          from = null;
        }
      }
      if (from !== null && (from === '0' || cmpVer(version, from) >= 0)) return true;
    }
  }
  return false;
}

// fixedIn(record, eco, name, version) — the lowest release the record names as fixed that is newer than version, or ''
function fixedIn(record, eco, name, version) {
  const fixes = (record.affected || []).filter(x => samePackage(x, eco, name))
    .flatMap(a => (a.ranges || []).filter(r => r.type !== 'GIT').flatMap(r => (r.events || []).map(e => e.fixed).filter(Boolean)))
    .filter(f => cmpVer(f, version) > 0).sort(cmpVer);
  return fixes[0] || '';
}

// cvss3(vector) — the CVSS v3.x base score of a vector string, or null when it isn't one
function cvss3(vector) {
  const m = String(vector || '').match(/^CVSS:3\.[01]\/(.*)$/);
  if (!m) return null;
  const v = Object.fromEntries(m[1].split('/').map(p => p.split(':')));
  const W = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
    CIA: { H: 0.56, L: 0.22, N: 0 },
  };
  const changed = v.S === 'C';
  const PR = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[v.PR];
  const [av, ac, ui, c, i, a] = [W.AV[v.AV], W.AC[v.AC], W.UI[v.UI], W.CIA[v.C], W.CIA[v.I], W.CIA[v.A]];
  if ([av, ac, ui, c, i, a, PR].some(x => x === undefined) || !['U', 'C'].includes(v.S)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av * ac * PR * ui;
  // CVSS 3.1's Roundup: the smallest number with one decimal that is at least the input
  const roundup = x => { const n = Math.round(x * 100000); return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10; };
  return roundup(Math.min((changed ? 1.08 : 1) * (impact + exploit), 10));
}

// severityOf(record) — critical, high, moderate, low or unknown: the label a reviewed database gave it (the GitHub
// Advisory Database's, in database_specific), else its CVSS v3 base score; a CVSS v4 vector alone is left unknown
function severityOf(record) {
  const label = String((record.database_specific && record.database_specific.severity) || '').toLowerCase();
  if (label === 'medium') return 'moderate';
  if (['critical', 'high', 'moderate', 'low'].includes(label)) return label;
  for (const s of record.severity || []) {
    const score = cvss3(s.score);
    if (score === null) continue;
    return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : score > 0 ? 'low' : 'unknown';
  }
  return 'unknown';
}

// problems(feed) — what's wrong with an [[advisory_feed]] entry (an empty list when it's usable)
function problems(f) {
  const p = [];
  if (!f || !f.name) p.push('needs a name');
  if (!FEED_KINDS.includes(f && f.kind)) p.push(`kind must be ${FEED_KINDS.join(', ')}`);
  else if (f.kind === 'osv-dir' && !f.path) p.push('an osv-dir feed needs path (a folder in your instance)');
  else if (f.kind !== 'osv-dir' && f.url !== undefined && !/^https:\/\//.test(f.url)) p.push('url must start with https://');
  else if (f.kind === 'osv-api' && !f.url) p.push('an osv-api feed needs url');
  if (f && f.ecosystems !== undefined && !Array.isArray(f.ecosystems)) p.push('ecosystems must be a list');
  return p;
}

// ignoreProblems(entry) — what's wrong with an [[advisory_ignore]] entry: every field is required, as for
// trust_policy_excludes (an exact advisory, package and version, the evidence, and when it stops)
function ignoreProblems(e) {
  return ['id', 'name', 'version', 'reason', 'expires'].filter(k => !e || !e[k]).map(k => `needs ${k}`);
}

// json(r) — a run's stdout as JSON, or null
const json = r => { if (!r || r.status !== 0) return null; try { return JSON.parse(r.stdout); } catch { return null; } };
const curl = (ctx, url, body, s = SETTINGS) => ctx.run('curl', ['-fsS', '-m', String(s.timeout_seconds), ...(body ? ['-H', 'Content-Type: application/json', '-d', body] : []), url]);

// inBatches(items, n, fn) — fn over items, n at a time
async function inBatches(items, n, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

// osvApi(ctx, feed, packages, say, s) — {hits: [{pkg, record}], error}: querybatch for every package, then each hit's record
async function osvApi(ctx, feed, packages, say, s = SETTINGS) {
  const base = feed.url.replace(/\/+$/, '');
  const want = packages.filter(p => !feed.ecosystems || feed.ecosystems.includes(p.ecosystem));
  // one query per distinct package and version; the tools that hold it come back from `want`
  const keys = [...new Map(want.map(p => [`${p.ecosystem}\0${p.name}\0${p.version}`, p])).values()];
  const ids = keys.map(() => []);
  const batch = s.batch_size;
  for (let i = 0; i < keys.length; i += batch) {
    say(`${feed.name}: ${Math.min(i + batch, keys.length)} of ${keys.length} package versions`);
    const body = JSON.stringify({ queries: keys.slice(i, i + batch).map(p => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) });
    const j = json(await curl(ctx, `${base}/querybatch`, body, s));
    if (!j || !Array.isArray(j.results)) return { hits: [], error: `${base}/querybatch gave no answer` };
    j.results.forEach((res, k) => { ids[i + k] = (res.vulns || []).map(v => v.id); });
  }
  const unique = [...new Set(ids.flat())];
  const records = new Map();
  await inBatches(unique, s.parallel, async id => {
    say(`${feed.name}: advisory ${id}`);
    const rec = json(await curl(ctx, `${base}/vulns/${encodeURIComponent(id)}`, '', s));
    if (rec) records.set(id, rec);
  });
  // a record with no severity of its own takes its GitHub alias's (the Go and PyPI databases rate nothing)
  await inBatches([...records.values()].filter(r => severityOf(r) === 'unknown'), s.parallel, async r => {
    const ghsa = (r.aliases || []).find(a => a.startsWith('GHSA-'));
    if (!ghsa) return;
    const g = records.get(ghsa) || json(await curl(ctx, `${base}/vulns/${ghsa}`, '', s));
    if (g && severityOf(g) !== 'unknown') r._severity = severityOf(g);
  });
  const missing = unique.filter(id => !records.has(id));
  const hits = [];
  keys.forEach((k, n) => {
    for (const id of ids[n]) {
      const record = records.get(id) || { id, affected: [] };
      for (const p of want.filter(p => p.ecosystem === k.ecosystem && p.name === k.name && p.version === k.version)) hits.push({ pkg: p, record });
    }
  });
  return { hits, error: missing.length ? `${missing.length} advisory record(s) couldn't be read (${missing.slice(0, 3).join(', ')})` : '' };
}

// osvDir(ctx, feed, packages) — {hits, error}: the OSV records in a folder of the instance that affect a package
function osvDir(ctx, feed, packages) {
  const dir = path.isAbsolute(feed.path) ? feed.path : path.join(ctx.instance, feed.path);
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return { hits: [], error: `${dir}: no such folder` }; }
  const hits = [], bad = [];
  for (const f of files) {
    let recs;
    try { recs = [].concat(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { bad.push(f); continue; }
    for (const record of recs) for (const p of packages) if (affects(record, p.ecosystem, p.name, p.version)) hits.push({ pkg: p, record });
  }
  return { hits, error: bad.length ? `${bad.length} file(s) aren't OSV JSON (${bad.slice(0, 3).join(', ')})` : '' };
}

// nodejs(ctx, feed, version) — {hits, error}: the newest release on the active Node's line, when a release newer than
// the active one is marked security
async function nodejs(ctx, feed, version, s = SETTINGS) {
  if (!version) return { hits: [], error: '' };
  const list = json(await curl(ctx, feed.url || 'https://nodejs.org/dist/index.json', '', s));
  if (!Array.isArray(list)) return { hits: [], error: 'nodejs.org/dist/index.json gave no answer' };
  const major = String(version).split('.')[0];
  const line = list.filter(r => String(r.version).replace(/^v/, '').split('.')[0] === major).map(r => ({ v: String(r.version).replace(/^v/, ''), security: r.security }));
  const sec = line.filter(r => r.security && cmpVer(r.v, version) > 0).sort((a, b) => cmpVer(b.v, a.v));
  if (!sec.length) return { hits: [], error: '' };
  const fixed = sec[0].v;
  return {
    hits: [{
      pkg: { ecosystem: 'node', name: 'node', version, tool: 'node', top: true },
      record: { id: `node-security-${fixed}`, summary: `${sec.length} newer security release(s) on Node ${major}`, _severity: 'unknown', _fixed: fixed },
    }],
    error: '',
  };
}

// kev(ctx, feed) — {ids: Set of CVE ids being exploited, error}
async function kev(ctx, feed, s = SETTINGS) {
  const j = json(await curl(ctx, feed.url || 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json', '', s));
  if (!j || !Array.isArray(j.vulnerabilities)) return { ids: new Set(), error: "CISA's KEV catalog gave no answer" };
  return { ids: new Set(j.vulnerabilities.map(v => v.cveID)), error: '' };
}

// lookup(ctx, feeds, inv, say) — {findings, failed: [{feed, error}], checked: [feed name]}. A finding: {pkg, id, aliases,
// summary, severity, fixed, kev, url, feed}; one per package, tool and advisory (aliases across feeds merged)
/** @param {any} ctx @param {any[]} feeds @param {any} inv @param {(text: string) => void} [say] @param {any} [s] */
async function lookup(ctx, feeds, inv, say = _text => {}, s = SETTINGS) {
  const failed = [], checked = [];
  const raw = [];
  let exploited = null;
  for (const f of feeds) {
    let r;
    try {
      if (f.kind === 'osv-api') r = await osvApi(ctx, f, inv.packages, say, s);
      else if (f.kind === 'osv-dir') r = osvDir(ctx, f, inv.packages);
      else if (f.kind === 'nodejs') { say(`${f.name}: nodejs.org release index`); r = await nodejs(ctx, f, inv.node, s); }
      else if (f.kind === 'kev') { say(`${f.name}: CISA's Known Exploited Vulnerabilities catalog`); const k = await kev(ctx, f, s); exploited = k.error ? exploited : k.ids; r = { hits: [], error: k.error }; }
    } catch (e) { r = { hits: [], error: e.message }; }
    if (r.error) failed.push({ feed: f.name, error: r.error });
    if (!r.error || r.hits.length) checked.push(f.name);
    for (const h of r.hits) raw.push({ ...h, feed: f.name });
  }
  const findings = [];
  for (const { pkg, record, feed } of raw) {
    const names = [record.id, ...(record.aliases || [])];
    const same = findings.find(x => x.pkg === pkg && names.some(n => n === x.id || x.aliases.includes(n)));
    if (same) { same.aliases = [...new Set([...same.aliases, ...names.filter(n => n !== same.id)])]; continue; }
    findings.push({
      pkg, id: record.id, aliases: (record.aliases || []).slice(), summary: record.summary || '',
      severity: record._severity || severityOf(record), fixed: record._fixed || fixedIn(record, pkg.ecosystem, pkg.name, pkg.version),
      url: pkg.ecosystem === 'node' ? 'https://nodejs.org/en/blog/vulnerability' : `https://osv.dev/vulnerability/${record.id}`, feed, kev: false,
    });
  }
  if (exploited) for (const f of findings) f.kev = [f.id, ...f.aliases].some(n => exploited.has(n));
  findings.sort((a, b) => Number(b.kev) - Number(a.kev) || rank(b.severity, s) - rank(a.severity, s) || a.pkg.tool.localeCompare(b.pkg.tool));
  return { findings, failed, checked };
}

// ignored(finding, entries, today) — the unexpired [[advisory_ignore]] entry that silences this finding, or null
function ignored(f, entries, today) {
  return (entries || []).find(e => !ignoreProblems(e).length && String(e.expires) >= today && e.name === f.pkg.name && e.version === f.pkg.version
    && (e.id === f.id || f.aliases.includes(e.id))) || null;
}

// serious(finding, s) — whether it goes on the review's work list: at or above s.action_severity (an unrated one at
// s.unrated's), or being exploited when s.exploited_always_action
const serious = (f, s = SETTINGS) => (f.kev && s.exploited_always_action) || rank(f.severity, s) >= RANK[s.action_severity];

// fixCommand(finding) — the steward command that takes the fix, or '' when there's none to name: the tool itself moves
// with upgrade-tool (an exact version is how a security fix is pinned), Node with node-patch; a package inside a tool
// waits for a release of that tool
function fixCommand(f) {
  if (!f.fixed) return '';
  if (f.pkg.ecosystem === 'node') return `steward sc node-patch ${f.fixed}`;
  if (f.pkg.top && !f.pkg.tool.startsWith('npm -g ')) return `steward sc upgrade-tool ${f.pkg.tool} ${f.fixed}`;
  return '';
}

module.exports = {
  FEED_KINDS, SEVERITIES, RANK, SETTINGS, settings, rank, ecosystemOf, lockPackages, walkNodeModules, npmTree, sitePackages, inventory, cmpVer, affects, fixedIn,
  cvss3, severityOf, problems, ignoreProblems, lookup, ignored, serious, fixCommand,
};
