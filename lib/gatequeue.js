#!/usr/bin/env node
// The release-age gate's queue (D56): what Renovate's Dependency Dashboard holds back in each repo, when each update
// clears the gate, and the next step for it. Read-only: it reads the dashboard issues and publish times with the
// owner's own `gh` and `npm`, and writes only its cache (<state>/review/gate-queue.json) for the `steward` banner.
// Three kinds of waiting, by the dashboard's headings:
//   - pending-checks     "Pending Status Checks": held by the release-age gate (minimumReleaseAge). Never tick these:
//                        ticking one opens the PR before the gate clears
//   - pending-approval   "Pending Approval": waits for a person's tick (dependencyDashboardApproval, the AI-owned tools)
//   - awaiting-schedule  "Awaiting Schedule": past the gate, waiting for its slot (the weekly "mise tools" digest)
// steward review shows it as "Waiting on the release-age gate"; the banner reads the cache only, never the network.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SECTIONS = { 'pending status checks': 'pending-checks', 'pending approval': 'pending-approval', 'awaiting schedule': 'awaiting-schedule' };

// parseTitle(title) — {dep, version}: what a Renovate PR title updates, and to which version (null for "to latest",
// a digest or a group). `chore(deps): update dependency npm:agentic-qe to v3.15.17` → npm:agentic-qe, 3.15.17
function parseTitle(title) {
  const t = title.replace(/^[\w-]+(\([^)]*\))?!?:\s*/, '').replace(/\s*\[[^\]]*\]\s*$/, '');
  const m = t.match(/^update (?:dependency )?(.+?)(?: action)? to (\S+)/i);
  if (!m) return { dep: null, version: null };
  const v = m[2].replace(/^v(?=\d)/, '');
  return { dep: m[1], version: /^\d+(\.\d+)*([-+][\w.]+)?$/.test(v) ? v : null };
}

// parseDashboard(body) — [{section, title, dep, version, branch}]: the checkbox lines under the three waiting headings.
// Any other heading (Detected Dependencies, Open, Rate-Limited …) and anything that isn't a checkbox line is skipped
function parseDashboard(body) {
  const items = [];
  let section = null;
  for (const line of String(body || '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = SECTIONS[h[1].toLowerCase()] || null; continue; }
    if (!section) continue;
    const c = line.match(/^\s*[-*]\s+\[[ xX]\]\s*(?:<!--\s*(?:[\w-]+=)?(\S*?)\s*-->)?\s*(.+?)\s*$/);
    if (!c) continue;
    items.push({ section, title: c[2], ...parseTitle(c[2]), branch: c[1] || null });
  }
  return items;
}

// zeroX(item) — the update is to a 0.x version, where a minor counts as a major (Renovate's branch says -0.x even when
// the title says "to latest")
const zeroX = i => /^0\./.test(i.version || '') || /-0\.x(-|$)/.test(i.branch || '');

// run(cmd, args) — the command's standard output, or null when it fails (the default; tests pass their own)
/** @param {string} cmd @param {string[]} args @returns {Promise<string|null>} */
const defaultRun = (cmd, args) => new Promise(resolve => execFile(cmd, args, { timeout: 60e3, maxBuffer: 16 << 20 }, (e, out) => resolve(e ? null : String(out))));
const json = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const date = s => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

// publishedAt(dep, version, run) — when that version was published, best effort; null when it can't say (then
// Renovate times it). npm: the registry's time map; owner/repo (an action, jdx/mise): its GitHub release; Node: the
// nodejs/node release. A bare name is tried on npm and kept only when that exact version is there
async function publishedAt(dep, version, run = defaultRun) {
  if (!dep || !version) return null;
  // npm 12 prints the time map inside an array ([{created, modified, <version>: <time>…}]); older npm, the map alone
  const npm = async pkg => { const x = json(await run('npm', ['view', pkg, 'time', '--json'])); const t = Array.isArray(x) ? Object.assign({}, ...x) : x; return date(t && typeof t === 'object' ? t[version] : null); };
  const gh = async repo => {
    for (const tag of [`v${version}`, version]) {
      const r = json(await run('gh', ['api', `repos/${repo}/releases/tags/${tag}`]));
      if (r && r.published_at) return date(r.published_at);
    }
    return null;
  };
  if (dep.startsWith('npm:')) return npm(dep.slice(4));
  if (/^node(\.js)?$/i.test(dep)) return gh('nodejs/node');
  if (dep.startsWith('@')) return npm(dep);
  if (/^[\w.-]+\/[\w.-]+$/.test(dep)) return gh(dep);
  if (/^[\w.-]+$/.test(dep)) return npm(dep);
  return null;
}

// clearsAt(published, days) — when the gate lets it through: published + days; null when published is unknown
const clearsAt = (published, days = 3) => (published ? new Date(new Date(published).getTime() + days * 864e5) : null);

const utc = d => `${new Date(d).toISOString().slice(0, 16).replace('T', ' ')}Z`;

// nextStep(item, {aiOwned, now}) — what to do about one waiting update, in words. item.clearsAt: a Date or null
function nextStep(item, { aiOwned = new Set(), now = new Date() } = {}) {
  const at = item.clearsAt ? new Date(item.clearsAt) : null;
  const waiting = at && at > now;
  const owned = aiOwned.has(item.dep);
  const node = /^node(\.js)?$/i.test(item.dep || '');
  let s;
  if (item.section === 'pending-approval') {
    s = owned ? 'qualify first (skills/ai-tooling/runbook.md), then tick it' : 'review, then tick it';
    if (waiting) s += `; it clears the gate ${utc(at)}`;
  } else if (item.section === 'awaiting-schedule') s = 'waits for its schedule; past the gate already';
  else {
    s = waiting ? `wait until ${utc(at)}` : at ? 'Renovate opens the PR' : 'Renovate opens the PR once it clears (it times it)';
    if (owned) s += '; qualify it before the merge (skills/ai-tooling/runbook.md)';
  }
  if (zeroX(item)) s += '; 0.x: a minor is a major; read its changes';
  if (node && item.section !== 'awaiting-schedule') s += `; after the merge: steward sc node-patch ${item.version || '<version>'}`;
  return s;
}

// order(rows, now) — cleared first, then by when each clears; unknown times last
function order(rows, now = new Date()) {
  const k = r => (r.clearsAt ? new Date(r.clearsAt).getTime() : Infinity);
  const cleared = r => (r.clearsAt && new Date(r.clearsAt) <= now ? 0 : 1);
  return [...rows].sort((a, b) => cleared(a) - cleared(b) || k(a) - k(b) || a.repo.localeCompare(b.repo) || a.title.localeCompare(b.title));
}

// cacheFile() — <state>/review/gate-queue.json
const cacheFile = () => path.join(require('./config.js').load().values.paths.state, 'review', 'gate-queue.json');

// queue({repos, now, run, days, aiOwned, cache}) — {rows, unreadable, none}: every repo's dashboard read and parsed,
// each item's clear time and next step, ordered (cleared first). unreadable: repos gh couldn't list; none: repos with
// no open dashboard. Writes the cache {at, rows:[{repo, title, section, clearsAt, next}]} unless cache is false
/** @param {{repos?: (string|null)[], now?: Date, run?: (cmd: string, args: string[]) => Promise<string|null>, days?: number, aiOwned?: Set<string>, cache?: string|false}} [opts] */
async function queue({ repos = [], now = new Date(), run = defaultRun, days, aiOwned, cache } = {}) {
  if (days === undefined || aiOwned === undefined) {
    const C = require('./config.js');
    const { values } = C.load();
    if (days === undefined) days = values.policy.min_release_age_days;
    if (aiOwned === undefined) aiOwned = new Set(values.profiles.ai_tooling ? ((C.policy('ai-tooling/ai-tooling.toml') || {}).owned_mise || []) : []);
  }
  const rows = [], unreadable = [], none = [];
  await Promise.all([...new Set(repos.filter(Boolean))].map(async repo => {
    const issues = json(await run('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--author', 'app/renovate', '--search', 'Dependency Dashboard in:title', '--json', 'number,body']));
    if (!Array.isArray(issues)) { unreadable.push(repo); return; }
    if (!issues.length) { none.push(repo); return; }
    const items = parseDashboard(issues[0].body);
    await Promise.all(items.map(async i => {
      const published = i.section === 'awaiting-schedule' ? null : await publishedAt(i.dep, i.version, run);
      const row = { repo, issue: issues[0].number, ...i, publishedAt: published, clearsAt: clearsAt(published, days) };
      rows.push({ ...row, next: nextStep(row, { aiOwned, now }) });
    }));
  }));
  const out = { rows: order(rows, now), unreadable: unreadable.sort(), none: none.sort() };
  if (cache !== false) {
    const file = cache || cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ at: now.toISOString(), rows: out.rows.map(r => ({ repo: r.repo, title: r.title, section: r.section, clearsAt: r.clearsAt ? r.clearsAt.toISOString() : null, next: r.next })) }, null, 1) + '\n');
  }
  return out;
}

// readCache(file) — the cache, or null when there's none or it doesn't parse
function readCache(file = cacheFile()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// bannerLine(cache, now) — one line when queued updates have cleared the gate since the review that cached them; else
// null. No network: the clear times are the review's
function bannerLine(cache, now = new Date()) {
  if (!cache || !Array.isArray(cache.rows)) return null;
  const since = date(cache.at);
  const n = cache.rows.filter(r => { const at = date(r.clearsAt); return at && at <= now && (!since || at > since); }).length;
  return n ? `${n} queued update(s) cleared the gate since the last review: steward review` : null;
}

module.exports = { parseDashboard, parseTitle, publishedAt, clearsAt, nextStep, order, queue, readCache, bannerLine, cacheFile, utc, zeroX };
