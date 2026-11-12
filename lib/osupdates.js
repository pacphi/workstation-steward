// OS updates on Linux (parity 1e, the Debian family, the owner, 2026-11-03; dnf 1e, Fedora, D84). Point releases and
// kernels arrive as apt or dnf packages, which those sources already date, gate and upgrade (new kernel packages
// included). What this adds, read-only, as the Mac's softwareupdate section does:
//   - a restart: /run/reboot-required, which Ubuntu and Mint write (update-notifier-common), and the running kernel
//     against the newest installed one, since Debian writes no file
//   - a newer release of the distribution, as a note: a release upgrade is a major, done by hand, never planned
//   - the end of this release's free security support (D-c's cap): a note within 90 days, an action once past
// Sources: distro-info-data's debian.csv (eol-lts, else eol) and ubuntu.csv (eol, LTS rows only), and Mint's release
// page for Mint and LMDE (the owner's choice, over saying it isn't checked). Fedora: `dnf5 needs-restarting -r` for the
// restart (it exits 1 and names what asks for one: dnf's step 0), and Bodhi's releases for the end (eol) and newer
// ones. Each is fetched once a day; one that
// can't be fetched or read is "not checked", never "up to date". Every command goes through ctx.run (tests: canned).
const fs = require('fs');
const path = require('path');

const SOURCES = {
  debian: 'https://salsa.debian.org/debian/distro-info-data/-/raw/main/debian.csv',
  ubuntu: 'https://salsa.debian.org/debian/distro-info-data/-/raw/main/ubuntu.csv',
  mint: 'https://www.linuxmint.com/download_all.php',
  // Bodhi: one release (its eol), and every release not archived (the newer ones)
  fedora: 'https://bodhi.fedoraproject.org/releases/',
};
const FIX = {
  restart: 'by hand: restart the machine',
  eol: 'by hand: move to a supported release (a major is deliberate)',
};
const SOON_DAYS = 90;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// which(sysroot) — {distro: debian|ubuntu|mint|lmde, version, codename, name, pretty} from os-release, or null
function which(sysroot = '/') {
  for (const f of ['etc/os-release', 'usr/lib/os-release']) {
    let t; try { t = fs.readFileSync(path.join(sysroot, f), 'utf8'); } catch { continue; }
    const v = k => ((t.match(new RegExp(`^${k}=["']?([^"'\\n]*)`, 'm')) || [])[1] || '');
    const id = v('ID'), version = v('VERSION_ID'), codename = v('VERSION_CODENAME'), pretty = v('PRETTY_NAME');
    const distro = id === 'linuxmint' ? (v('UBUNTU_CODENAME') ? 'mint' : 'lmde') : id;
    if (!['debian', 'ubuntu', 'mint', 'lmde', 'fedora'].includes(distro)) return null;
    const name = { debian: `Debian ${version}`, ubuntu: `Ubuntu ${version}`, mint: `Linux Mint ${version}`, lmde: `LMDE ${version}`, fedora: `Fedora ${version}` }[distro];
    return { distro, version, codename, name, pretty };
  }
  return null;
}

// restartFile(sysroot) — {needed, pkgs}: /run/reboot-required, and the packages its .pkgs file names (once each)
function restartFile(sysroot = '/') {
  const f = path.join(sysroot, 'run', 'reboot-required');
  if (!fs.existsSync(f)) return { needed: false, pkgs: [] };
  let pkgs = [];
  try { pkgs = [...new Set(fs.readFileSync(`${f}.pkgs`, 'utf8').split('\n').map(l => l.trim()).filter(Boolean))]; } catch { /* no list */ }
  return { needed: true, pkgs };
}

// kernel(ctx) — {running, newest}: uname -r and the newest installed linux-image-<version> (signed or unsigned), or null
// when no kernel package is installed (a container)
async function kernel(ctx) {
  const { verLt } = require('../supply-chain/checks/index.js'); // here, since that module requires this one
  const r = await ctx.run('dpkg-query', ['-W', '-f=${Package}\t${Status}\n', 'linux-image-*']);
  const vers = String(r.stdout || '').split('\n').map(l => l.split('\t'))
    .filter(([p, s]) => p && /^install ok installed$/.test(s || '')).map(([p]) => (p.match(/^linux-image-(?:unsigned-)?(\d.*)$/) || [])[1]).filter(Boolean);
  if (!vers.length) return null;
  const newest = vers.reduce((a, b) => (verLt(a, b) ? b : a));
  return { running: (await ctx.run('uname', ['-r'])).stdout.trim(), newest };
}

// needsRestart(ctx) — {needed, why} from `dnf5 needs-restarting -r` (Fedora): exit 0 is none, exit 1 is one, with the
// lines naming what asks for it; any other answer is null (not checked). Read as you: it reads the rpm database and
// the boot time, no repo
async function needsRestart(ctx) {
  const r = await ctx.run('dnf5', ['-q', 'needs-restarting', '-r']);
  if (r.status === 0) return { needed: false, why: [] };
  if (r.status !== 1) return null;
  const names = [...new Set(String(r.stdout || '').split('\n').map(l => l.trim()).filter(l => /^\*\s*\S/.test(l)).map(l => l.replace(/^\*\s*/, '')))];
  return { needed: true, why: names };
}

// fromBodhi(mine, list, version, today) — {endsOn, newer} for Fedora <version> from Bodhi: mine is /releases/F<version>
// (its eol), list is /releases/?exclude_archived=true (Fedora's own F<n> rows only, not the container, Flatpak or EPEL
// ones); newer is the highest version already released (released_on on or before today, else state current). null
// when mine doesn't read as a Fedora release
function fromBodhi(mine, list, version, today) {
  if (!mine || mine.name !== `F${version}`) return null;
  const rel = r => r && /^F\d+$/.test(r.name || '') && Number(r.version) > Number(version)
    && (r.released_on ? String(r.released_on).slice(0, 10) <= today : r.state === 'current');
  const top = ((list && list.releases) || []).filter(rel).reduce((a, r) => (!a || Number(r.version) > Number(a.version) ? r : a), null);
  const eol = /^\d{4}-\d{2}-\d{2}/.test(mine.eol || '') ? String(mine.eol).slice(0, 10) : null;
  return { endsOn: eol, newer: top ? { version: String(top.version), name: `Fedora ${top.version}` } : null };
}

// csvRows(text) — distro-info-data's rows as objects by its header, or null when it isn't that file
function csvRows(text) {
  const ls = String(text || '').split('\n').filter(Boolean);
  const head = (ls[0] || '').split(',');
  if (!['version', 'codename', 'series', 'release', 'eol'].every(k => head.includes(k))) return null;
  return ls.slice(1).map(l => Object.fromEntries(l.split(',').map((x, i) => [head[i], x])));
}

// fromCsv(text, kind, codename, today) — {endsOn, newer} for that release from debian.csv or ubuntu.csv: free support
// ends on Debian LTS's date (else eol), on Ubuntu's standard support's; newer is the newest release already out after it
// (Ubuntu: LTS rows only, D-c). null when the file doesn't read or doesn't know the release
function fromCsv(text, kind, codename, today) {
  const rows = csvRows(text);
  if (!rows) return null;
  const use = kind === 'ubuntu' ? rows.filter(r => /LTS/.test(r.version)) : rows.filter(r => r.version);
  const i = use.findIndex(r => r.series === codename);
  if (i < 0) return null;
  const me = use[i];
  const out = use.slice(i + 1).filter(r => r.release && r.release <= today);
  const n = out[out.length - 1];
  const label = kind === 'ubuntu' ? 'Ubuntu' : 'Debian';
  return { endsOn: (kind === 'debian' && me['eol-lts']) || me.eol || null, newer: n ? { version: n.version, codename: n.series, name: `${label} ${n.version} (${n.series})` } : null };
}

// mintRows(html) — [{version, base, until}] from Mint's release page: each row's cells are version, name, edition, base
// and the support text ("…supported until April 2029.")
function mintRows(html) {
  const rows = [];
  for (const tr of String(html || '').split(/<tr[\s>]/i).slice(1)) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
    if (cells.length < 5 || !/^\d+(\.\d+)?$/.test(cells[0]) || !/^(Ubuntu|Debian) /.test(cells[3]) || !/support/i.test(cells[4])) continue;
    const m = cells[4].match(/supported until (\w+) (\d{4})/i);
    const mon = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
    const until = mon >= 0 ? new Date(Date.UTC(Number(m[2]), mon + 1, 0)).toISOString().slice(0, 10) : null;
    rows.push({ version: cells[0], base: cells[3].split(' ')[0], until });
  }
  return rows;
}

// fromMintPage(html, edition, version, today) — {endsOn, newer} for Mint (an Ubuntu base) or LMDE (a Debian one): the
// month's last day of "supported until", and the highest version listed above this one. null when the page no longer
// reads as it did, or no longer lists this release
function fromMintPage(html, edition, version, _today) {
  const base = edition === 'lmde' ? 'Debian' : 'Ubuntu';
  const rows = mintRows(html).filter(r => r.base === base);
  const me = rows.find(r => r.version === version);
  if (!me) return null;
  const num = v => v.split('.').map(Number);
  const gt = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  const top = rows.filter(r => gt(r.version, version)).reduce((a, r) => (!a || gt(r.version, a.version) ? r : a), null);
  return { endsOn: me.until, newer: top ? { version: top.version, name: `${edition === 'lmde' ? 'LMDE' : 'Linux Mint'} ${top.version}` } : null };
}

// days(from, to) — whole days from one YYYY-MM-DD to another
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
// endState(endsOn, today) — ok, soon (within 90 days, the last day included), past, or unknown without a date
function endState(endsOn, today) {
  if (!endsOn) return 'unknown';
  const left = days(today, endsOn);
  return left < 0 ? 'past' : left <= SOON_DAYS ? 'soon' : 'ok';
}

// fetchDaily(ctx, key, url) — the source's text, fetched once a day into <cache>/os-<day>/<key>; '' when it can't be had
async function fetchDaily(ctx, key, url) {
  const f = path.join(ctx.cache, `os-${ctx.today.replace(/-/g, '')}`, key);
  try { return fs.readFileSync(f, 'utf8'); } catch { /* not yet today */ }
  const r = await ctx.run('curl', ['-fsSL', '--max-time', '20', url], { label: `${key} (${new URL(url).host})` });
  if (r.status !== 0 || !r.stdout) return '';
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, r.stdout);
  return r.stdout;
}

// releaseFacts(ctx, w) — {facts, why}: {endsOn, newer} for this release from its source, or why it isn't known
async function releaseFacts(ctx, w) {
  if (w.distro === 'fedora') {
    const j = t => { try { return JSON.parse(t); } catch { return null; } };
    const mine = j(await fetchDaily(ctx, `bodhi-F${w.version}.json`, `${SOURCES.fedora}F${encodeURIComponent(w.version)}`));
    const list = mine && j(await fetchDaily(ctx, 'bodhi-releases.json', `${SOURCES.fedora}?exclude_archived=true&rows_per_page=100`));
    if (!mine || !list) return { why: "Bodhi's releases could not be fetched" };
    const f = fromBodhi(mine, list, w.version, ctx.today);
    return f ? { facts: f, source: 'Bodhi' } : { why: `Bodhi doesn't list F${w.version}` };
  }
  if (w.distro === 'mint' || w.distro === 'lmde') {
    const html = await fetchDaily(ctx, 'mint-download_all.html', SOURCES.mint);
    if (!html) return { why: "Mint's release page could not be fetched" };
    const f = fromMintPage(html, w.distro, w.version, ctx.today);
    return f ? { facts: f, source: "Mint's release page" } : { why: "Mint's release page no longer reads as it did" };
  }
  const text = await fetchDaily(ctx, `${w.distro}.csv`, SOURCES[w.distro]);
  if (!text) return { why: `${w.distro}.csv could not be fetched` };
  const f = fromCsv(text, w.distro, w.codename, ctx.today);
  return f ? { facts: f, source: `distro-info-data ${w.distro}.csv` } : { why: `${w.distro}.csv doesn't list ${w.codename || w.name}` };
}

// check(ctx, out) — the audit section (supply-chain/checks/index.js `os-updates`)
async function check(ctx, out) {
  const sys = ctx.sysroot || '/';
  const w = which(sys);
  const pm = w && w.distro === 'fedora' ? 'dnf' : 'apt';
  out.info(`point updates arrive as ${pm} packages (${pm} packages, above), new kernels included`);
  if (!w) { out.note('this distribution: not one this section knows (Debian, Ubuntu, Linux Mint, LMDE, Fedora): not checked'); return; }

  if (w.distro === 'fedora') {
    const n = await needsRestart(ctx);
    if (!n) out.note('restart: not checked (dnf5 needs-restarting gave no answer)');
    else if (n.needed) out.action(`os: restart needed: dnf5 needs-restarting${n.why.length ? ` (${n.why.join(', ')})` : ''}`, { fix: FIX.restart, name: 'restart' });
    else out.ok('no restart needed');
    return releaseLines(ctx, out, w);
  }

  const file = restartFile(sys);
  const k = await kernel(ctx);
  const why = [];
  if (file.needed) why.push(`/run/reboot-required${file.pkgs.length ? ` (${file.pkgs.join(', ')})` : ''}`);
  const { verLt } = require('../supply-chain/checks/index.js');
  if (k && k.running !== k.newest && verLt(k.running, k.newest)) why.push(`the running kernel ${k.running} is older than the installed ${k.newest}`);
  if (why.length) out.action(`os: restart needed: ${why.join('; ')}`, { fix: FIX.restart, name: 'restart' });
  else if (!k) out.note('restart: no kernel package installed here (a container?): checked by /run/reboot-required only');
  else out.ok('no restart needed');
  return releaseLines(ctx, out, w);
}

// releaseLines(ctx, out, w) — the newer release (a note) and the end of free security support, from the release's source
async function releaseLines(ctx, out, w) {
  const r = await releaseFacts(ctx, w);
  if (!r.facts) { out.note(`newer release and support end: not checked (${r.why})`); return; }
  const { endsOn, newer } = r.facts;
  if (newer) out.note(`newer release: ${newer.name} is out; a release upgrade is a major: by hand`);
  const st = endState(endsOn, ctx.today);
  if (st === 'unknown') out.note(`free security support: no end date published (${r.source})`);
  else if (st === 'past') out.action(`os: ${w.name}'s free security support ended ${endsOn}`, { fix: FIX.eol, name: w.name, note: r.source });
  else if (st === 'soon') out.note(`free security support ends in ${days(ctx.today, endsOn)} days (${endsOn}): plan the move`);
  else out.info(`free security support until ${endsOn} (${r.source})`);
}

module.exports = { SOURCES, FIX, which, restartFile, kernel, needsRestart, fromCsv, fromMintPage, fromBodhi, endState, check };
