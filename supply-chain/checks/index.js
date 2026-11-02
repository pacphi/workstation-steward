// The host audit's checks (R5c): each section of the former Bash audit as data, so a platform runs only the checks
// that apply to it and a package manager is a provider (lib/providers/). Read-only: a check reports, it never changes
// anything. Every command goes through ctx.run (async, so a live display keeps moving), so tests hand them canned output.
//   check: { id, name (the step's short name), title(ctx) (the plain output's header), platforms, async run(ctx, out) }
//   out:   line(text) (an indented line as it comes), ok/held/info/clean(text), note(text) (info the terminal never
//          folds away), action(text), alert(text)
//          action and held also take facts, which only the terminal view reads (the plain text stays as it is):
//          { fix (what to do, the heading a finding is listed under), name, have, want, age (days), note }
// ctx: { run, cfg (lib/config.js values), policy (lib/host.js merged), instance, engine, cache, today, home, now,
//        platform, appDirs (where apps live; tests only) }
const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const brew = require('../../lib/providers/brew.js');
const P = require('../../lib/providers/index.js');
const U = require('../../lib/updaters.js');
const V = require('../../lib/vulns.js');

const ALL = ['macos', 'linux', 'windows'];
// ageDays and securityException live with the package sources (lib/providers/index.js); kept here for the checks
const { ageDays, securityException } = P;

// verLt(a, b) — a sorts before b as `sort -V` would (bash ver_lt): runs of digits compare as numbers
function verLt(a, b) {
  if (a === b) return false;
  const parts = s => String(s).match(/\d+|\D+/g) || [];
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return true;
    if (y[i] === undefined) return false;
    const dx = /^\d/.test(x[i]), dy = /^\d/.test(y[i]);
    if (dx && dy) { const d = Number(x[i]) - Number(y[i]); if (d) return d < 0; if (x[i].length !== y[i].length) return x[i].length > y[i].length; continue; }
    if (x[i] !== y[i]) return x[i] < y[i];
  }
  return false;
}

// appVersion(have, want) — the app's bundle version in the cask's terms: Chromium-based apps prefix the Chromium major
// (Brave 156.1.98.60 is cask 1.98.60.0)
const appVersion = (have, want) => {
  const v = String(have).split(' ')[0];
  return parseInt(v, 10) > 100 && parseInt(want, 10) < 10 ? v.slice(v.indexOf('.') + 1) : v;
};

// appBehind(have, want) — an app is behind its cask when its numbers sort lower. Only the numbers count, without
// trailing zeros: a cask writes the same release with a channel word or an extra .0 (Warp 0.2026.10.21.08.25.02 is
// cask 0.2026.10.21.08.25.stable_02; Brave 1.98.60 is cask 1.98.60.0)
function appBehind(have, want) {
  const nums = s => { const n = (String(s).match(/\d+/g) || []).map(Number); while (n.length && n[n.length - 1] === 0) n.pop(); return n; };
  const x = nums(have), y = nums(want);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

// caskIds(cask) — the bundle IDs a cask names in its uninstall and zap steps (com.vendor.app, from paths such as
// ~/Library/Containers/com.vendor.app), without an app group's `group.` or a team ID's prefix
const caskIds = c => [...new Set((JSON.stringify(c.artifacts || []).match(/[A-Za-z0-9]{2,}(?:\.[A-Za-z0-9-]+){2,}/g) || [])
  .map(s => s.replace(/^group\./, '').replace(/^[A-Z0-9]{10}\./, ''))
  .filter(s => /^[a-z]/i.test(s) && !/\.(plist|app|pkg|dmg|zip|json|log|db|sqlite|savedState|binarycookies)$/i.test(s)))];
// vendor(id) — a bundle ID's first two parts: com.microsoft.m365copilot is com.microsoft's
const vendor = id => String(id).toLowerCase().split('.').slice(0, 2).join('.');

// pickCask(casks, id) — {cask} for an app with bundle ID id, among the casks that install an app of its name: one
// that names a bundle ID from the app's vendor, else one that names none (the name is all there is to go on); or
// {other} when every one names only other vendors' IDs (another product with the same name: Copilot.app is both
// Microsoft 365 Copilot and the Copilot Money app)
function pickCask(casks, id) {
  if (!id) return { cask: casks[0] };
  const named = casks.map(c => ({ c, ids: caskIds(c) }));
  const mine = named.find(x => x.ids.some(i => vendor(i) === vendor(id))) || named.find(x => !x.ids.length);
  return mine ? { cask: mine.c } : { other: named[0] };
}

// packages(id) — the audit check's run for a package source (parity 0.2): each package behind, judged as the plan
// judges it (lib/providers/index.js judge); a self-updating one is left to the app check
const packages = id => async (ctx, out) => {
  const s = P.byId(id), min = minAge(ctx);
  for (const it of await s.outdated(ctx)) {
    if (it.auto) continue;
    const { name, have, want } = it;
    const j = await P.judge(ctx, s, it), age = j.age;
    const facts = { fix: FIX.upgrade, name, have, want, age };
    if (j.exception) out.action(`${s.tag}: ${name} ${have} -> ${want} (security exception: ${j.exception})`, { ...facts, note: `security exception: ${j.exception}` });
    else if (j.verdict === 'take') out.action(`${s.tag}: ${name} ${have} -> ${want} (${age}d old)`, facts);
    else out.held(`${name} ${have} -> ${want} (${age}d old${s.heldEta ? `; eligible in ${min - age}d` : ''})`, { ...facts, note: `eligible in ${min - age}d` });
  }
  for (const l of await s.manual(ctx)) out.line(s.manualText('audit', l));
};

const minAge = ctx => ctx.cfg.policy.min_release_age_days;
// processes(ctx) — {list: [{pid, cmd, env}], error}: every process but the audit's own, its command line and, where this
// user may read it, its environment (null when not). ps on macOS, which shows no process environment (checked on macOS
// 27.2, 2026-11-02); /proc on Linux, since minimal installs often have no ps (the debian:13 and fedora:44 images have
// none; parity 0.4). error says why there is no list, so the IOC check says "not fully checked" instead of a clean that
// never looked.
async function processes(ctx) {
  if (ctx.platform === 'linux') return fromProc(ctx.proc || '/proc');
  if (ctx.platform !== 'macos') return { list: [], error: 'no process list on this platform yet' };
  const r = await ctx.run('ps', ['-axeww', '-o', 'pid=,command=']);
  if (r.status !== 0) return { list: [], error: `ps failed, exit ${r.status}` };
  const list = r.stdout.split('\n').map(l => l.trim().match(/^(\d+)\s+(.*)$/)).filter(m => m && Number(m[1]) !== process.pid).map(m => ({ pid: Number(m[1]), cmd: m[2], env: null }));
  return list.length ? { list, error: null } : { list: [], error: 'ps listed no processes' };
}
// fromProc(proc) — processes() on Linux: each /proc/<pid>'s cmdline and environ, NULs as spaces; a process with no
// command line (a kernel thread) or that is gone is skipped, and an environment this user can't read is null
function fromProc(proc) {
  let pids;
  try { pids = fs.readdirSync(proc).filter(n => /^\d+$/.test(n) && Number(n) !== process.pid).sort((a, b) => Number(a) - Number(b)); } catch (e) { return { list: [], error: `/proc can't be read (${e.code || e.message})` }; }
  const read = f => { try { return fs.readFileSync(f).toString('utf8').split('\0').filter(Boolean).join(' '); } catch { return null; } };
  const list = [];
  for (const pid of pids) {
    const cmd = read(path.join(proc, pid, 'cmdline'));
    if (cmd) list.push({ pid: Number(pid), cmd, env: read(path.join(proc, pid, 'environ')) });
  }
  return { list, error: null };
}

// SYSTEM_BUNDLE — each Linux family's system CA bundle, the file its TLS libraries read (each checked in its test image,
// 2026-11-02: Debian 13 and Ubuntu 26.04; Fedora 44; openSUSE Leap 16.0 and Tumbleweed); parity 0.5
const SYSTEM_BUNDLE = {
  debian: '/etc/ssl/certs/ca-certificates.crt',
  rhel: '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  suse: '/var/lib/ca-certificates/ca-bundle.pem',
};
// systemBundle(ctx) — this machine's system CA bundle: its family's, else the first of the others that exists (Arch, for
// one, uses Debian's path), else null. ctx.sysroot stands in for / in tests
function systemBundle(ctx) {
  const at = p => path.join(ctx.sysroot || '/', p);
  const tries = [SYSTEM_BUNDLE[ctx.family], ...Object.values(SYSTEM_BUNDLE)].filter(Boolean).map(at);
  return tries.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

// pythonRoots(ctx) — the Python folders beyond the tools' own that hold packages: on Linux the system's
// (/usr/lib/python3*, /usr/local/lib/python3*: Debian's dist-packages among them) and pip --user's
// (~/.local/lib/python3*); on macOS pip --user's (~/Library/Python/3.*). Only folders that exist. ctx.sysroot: tests
function pythonRoots(ctx) {
  const sys = ctx.sysroot || '/';
  const under = (dir, re) => { try { return fs.readdirSync(dir).filter(n => re.test(n)).map(n => path.join(dir, n)); } catch { return []; } };
  const roots = ctx.platform === 'linux'
    ? [...under(path.join(sys, 'usr', 'lib'), /^python3/), ...under(path.join(sys, 'usr', 'local', 'lib'), /^python3/), ...under(path.join(ctx.home, '.local', 'lib'), /^python3/)]
    : ctx.platform === 'macos' ? under(path.join(ctx.home, 'Library', 'Python'), /^3\./) : [];
  return roots.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

// detail(ctx, text) — what a slow check is on now, for the terminal's live line only (audit.js ctx.detail; plain output
// and the tests' contexts have none)
const detail = (ctx, text) => { if (ctx.detail) ctx.detail(text); };
// what to do about a finding: the headings the terminal view lists findings under
const FIX = {
  upgrade: 'steward sc plan, then steward sc upgrade',
  browser: 'by hand: browsers, update now (always_current)',
  vendor: 'by hand: update in the app (its own updater)',
  electron: n => `by hand: Electron below ${n}: update the app, or ask its vendor`,
  appstore: 'by hand: the App Store',
  macos: 'by hand: System Settings, Software Update',
  docker: 'by hand: pin each image by tag@digest',
  pin: 'review the new key, then update the pin in a config-repo PR (the supply-chain runbook)',
  selfUpdate: name => `turn ${name}'s own updater off`,
  processList: 'by hand: let the audit read the process list (ps on macOS, /proc on Linux), then run it again',
  trustLinux: 'by hand: remove the root from the system trust store (parity 2.1 adds the command)',
};
const tomlGet = async (ctx, file, expr) => { const r = (await ctx.run('yq', ['-p', 'toml', '-oy', '-r', expr, file])); return r.status === 0 ? r.stdout.trim() : ''; };

const CHECKS = [
  {
    id: 'mise-status', name: 'mise toolchain', platforms: ALL, title: () => 'mise toolchain (bin/status)',
    async run(ctx, out) { for (const l of (await ctx.run(path.join(ctx.engine, 'supply-chain', 'bin', 'status'), [], { label: 'mise status' })).stdout.split('\n').filter(Boolean)) out.line(l); },
  },
  {
    // mise itself (status printed the detail): an eligible release, or an advisory waiting on an exception
    id: 'mise-self', name: 'mise itself', platforms: ALL, title: null,
    async run(ctx, out) {
      detail(ctx, 'mise releases (GitHub and two advisory databases)');
      const [act, current, target, reason, auto] = (await ctx.run('node', [path.join(ctx.engine, 'supply-chain', 'bin', 'mise-self.js'), '--plan'])).stdout.trim().split('\t');
      if (act === 'take') out.action(`mise: ${current} -> ${target} (${reason}): steward sc upgrade-tool mise`, { fix: 'steward sc upgrade-tool mise', name: 'mise', have: current, want: target, note: reason });
      if (act === 'hold' && String(reason).includes('security_exception')) out.action(`mise: ${current} (${reason})`);
      if (auto === 'true') out.action('mise: self_update.auto is on; it replaces the binary without a backup or receipt: mise settings set self_update.auto false', { fix: 'mise settings set self_update.auto false', name: 'mise self_update.auto', have: 'on', want: 'off', note: 'it replaces the binary without a backup or receipt' });
    },
  },
  {
    id: 'host-policy', name: 'Host policy', platforms: ALL, title: () => "Host policy (the engine's shared defaults under your supply-chain/host.toml; steward sc host shows each value's source)",
    async run(ctx, out) {
      const summary = (await ctx.run('node', [path.join(ctx.engine, 'lib', 'host.js')])).stdout.split('\n');
      out.line(summary[0]);
      for (const w of summary.filter(l => l.includes('WARN '))) out.action(`host.toml ${w.slice(w.indexOf('WARN ') + 5)}`);
    },
  },
  {
    id: 'release-age', name: 'Release-age gate', platforms: ALL, title: () => 'Release-age gate (steward.toml is the authority; mise and Renovate must agree: steward sc release-age <days>)',
    async run(ctx, out) {
      const min = minAge(ctx);
      const mise = (await tomlGet(ctx, path.join(ctx.instance, 'mise', 'config.toml'), '.settings.minimum_release_age // ""'));
      let ren = '';
      try { ren = String(JSON.parse(fs.readFileSync(path.join(ctx.instance, 'renovate.json'), 'utf8')).minimumReleaseAge || ''); } catch { /* unset */ }
      for (const [where, val] of [['mise/config.toml minimum_release_age', mise], ['renovate.json minimumReleaseAge', ren]]) {
        if (val.replace(/\D/g, '') === String(min)) out.ok(`${where} = ${val}`);
        else out.action(`${where} = ${val || 'unset'}, steward.toml says ${min} day(s) (steward sc release-age ${min})`, { fix: `steward sc release-age ${min}`, name: where, have: val || 'unset', want: `${min} day(s)` });
      }
    },
  },
  {
    // [[updater]] (D52): sources the steward doesn't install itself; the class says whether one waits for the gate
    id: 'updaters', name: 'Declared updaters', platforms: ALL,
    title: () => "Declared updaters ([[updater]]: the engine's defaults and yours, where their tool is installed; the class decides the gate)",
    async run(ctx, out) {
      const list = U.active(ctx.policy);
      if (!list.length) { out.line('none active here'); return; }
      for (const u of list) {
        const cls = U.classOf(u, ctx.today);
        const off = U.selfUpdate(u);
        if (!off.ok) out.action(`${u.name}: its own updater isn't off (${u.self_update_off.file} = ${off.have}); set it to ${u.self_update_off.value}`, { fix: FIX.selfUpdate(u.name), name: `${u.name} self-update`, have: off.have, want: String(u.self_update_off.value) });
        const pin = U.pinState(u);
        if (!pin.ok) { out.action(`${u.name}: ${pin.why}; review the new key, then update the pin in a config-repo PR`, { fix: FIX.pin, name: u.name, note: 'signing key changed' }); continue; }
        const c = await U.check(u, ctx.run);
        if (c.state === 'current') out.ok(`${u.name} (${cls}, ${u._source}): up to date`);
        else if (c.state === 'unknown') out.info(`${u.name}: its check couldn't tell (exit ${c.status})`);
        else if (cls === 'gated') out.held(`${u.name} (gated): behind; a declared source has no release date, so it waits for you`, { name: u.name, note: 'gated' });
        else out.action(`${u.name}: behind (${cls}: ${U.SKIPS[cls]})`, { fix: FIX.upgrade, name: u.name, note: cls });
      }
    },
  },
  {
    id: 'brew-formulae', name: 'Homebrew formulae', platforms: brew.platforms, provider: brew,
    title: ctx => `Homebrew formulae (live API; eligible = at least ${minAge(ctx)}d in homebrew-core, or a host.toml security exception)`,
    run: packages('brew-formula'),
  },
  {
    id: 'brew-casks', name: 'Homebrew casks', platforms: ['macos'], provider: brew, title: () => 'Homebrew casks (casks that update themselves are judged by their app bundle below)',
    run: packages('brew-cask'),
  },
  {
    id: 'apps', name: 'Apps and Electron', platforms: ['macos'],
    title: ctx => `Apps (bundle version vs Homebrew cask catalog; Electron vs its ${ctx.policy.electron_supported_majors ?? 3} supported majors)`,
    async run(ctx, out) {
      const min = minAge(ctx), majors = ctx.policy.electron_supported_majors ?? 3;
      const byApp = new Map(); // an app's name -> the casks that install an app of that name
      for (const c of (await brew.api(ctx, 'cask'))) for (const a of c.artifacts || []) for (const app of [].concat((a && a.app) || [])) {
        if (typeof app === 'string') byApp.set(app, [...(byApp.get(app) || []), c]);
      }
      const always = new Set(ctx.policy.always_current || []);
      detail(ctx, "Electron's latest release (npm)");
      const latest = (await ctx.run('npm', ['view', 'electron', 'dist-tags.latest'])).stdout.trim() || '0';
      const electronMin = parseInt(latest, 10) - majors + 1;
      const plist = async (f, key) => (await ctx.run('defaults', ['read', f, key])).stdout.trim();
      const apps = [];
      for (const dir of ctx.appDirs || ['/Applications', path.join(ctx.home, 'Applications')]) {
        let names = [];
        try { names = fs.readdirSync(dir).filter(n => n.endsWith('.app')).sort(); } catch { /* none */ }
        for (const n of names) apps.push(path.join(dir, n));
      }
      for (const [i, app] of apps.entries()) {
        detail(ctx, `${i + 1}/${apps.length} ${path.basename(app)}`);
        if (!fs.statSync(app).isDirectory() || fs.existsSync(path.join(app, 'Contents', '_MASReceipt'))) continue; // App Store apps: below
        const base = path.basename(app), short = base.replace(/\.app$/, '');
        const have = (await plist(path.join(app, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'));
        const ep = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist');
        if (fs.existsSync(ep)) {
          const ev = (await plist(ep, 'CFBundleVersion')) || '0';
          if (parseInt(ev, 10) < electronMin) out.action(`app: ${short} bundles Electron ${ev} (supported: ${electronMin}+); update it, or ask the vendor`, { fix: FIX.electron(electronMin), name: short, have: `Electron ${ev.replace(/-.*$/, '')}`, want: `${electronMin}+` });
        }
        if (!byApp.has(base) || !have) continue;
        const id = await plist(path.join(app, 'Contents', 'Info.plist'), 'CFBundleIdentifier');
        const pick = pickCask(byApp.get(base), id);
        if (pick.other) { out.info(`${short} (${id}): cask ${pick.other.c.token} is another app of that name (${pick.other.ids.slice(0, 2).join(', ')}); not compared`); continue; }
        const c = { token: pick.cask.token, want: String(pick.cask.version).split(',')[0] };
        const v = appVersion(have, c.want);
        if (!appBehind(v, c.want)) continue;
        const age = ageDays((await brew.releaseDate(ctx, 'cask', c.token, c.want)), ctx.now);
        const facts = { name: short, have: v, want: c.want, age };
        if (always.has(c.token)) out.action(`app: ${short} ${v} -> ${c.want} (${age}d old; always_current: update now)`, { ...facts, fix: FIX.browser, note: 'always_current' });
        else if (age >= min || age < 0) out.action(`app: ${short} ${v} -> ${c.want} (${age}d old; vendor updater; matched cask ${c.token} by app name)`, { ...facts, fix: FIX.vendor, note: 'vendor updater' });
        else out.held(`${short} ${v} -> ${c.want} (${age}d old; matched cask ${c.token})`, { ...facts, note: `eligible in ${min - age}d` });
      }
    },
  },
  {
    id: 'app-store', name: 'App Store', platforms: ['macos'], title: () => 'App Store (mas)',
    async run(ctx, out) {
      if ((await ctx.run('mas', ['version'])).status !== 0) { out.warn('mas not installed (brew install mas): App Store not checked'); return; }
      const lines = (await ctx.run('mas', ['outdated'], { label: 'mas outdated' })).stdout.split('\n').filter(Boolean);
      // mas outdated: `<id>  <name>  (<have> -> <want>)`
      const facts = l => { const m = l.match(/^\s*\d+\s+(.*?)\s+\((\S+) -> (\S+)\)\s*$/); return m ? { fix: FIX.appstore, name: m[1], have: m[2], want: m[3] } : { fix: FIX.appstore }; };
      if (lines.length) for (const l of lines) out.action(`appstore: ${l}`, facts(l)); else out.line('up to date');
    },
  },
  {
    id: 'macos', name: 'macOS updates', platforms: ['macos'], title: () => 'macOS (softwareupdate -l)',
    async run(ctx, out) {
      const r = (await ctx.run('softwareupdate', ['-l'], { label: "softwareupdate -l (Apple's server can take a minute)", stderr: true }));
      const labels = r.stdout.split('\n').filter(l => /^\s*\* Label:/.test(l));
      if (labels.length) for (const l of labels) out.action(`macOS: ${l.slice(l.indexOf('Label: ') + 7)}`, { fix: FIX.macos, name: l.slice(l.indexOf('Label: ') + 7) });
      else out.line(`${(await ctx.run('sw_vers', ['-productVersion'])).stdout.trim()}: no updates`);
    },
  },
  {
    id: 'trust', name: 'Trust stores', platforms: ['macos', 'linux'], title: () => "Trust stores (distrusted_root: the engine's defaults and yours)",
    async run(ctx, out) {
      const pemHas = (file, sha) => {
        let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
        return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).some(p => new X509Certificate(p).fingerprint256.replace(/:/g, '') === sha.toUpperCase());
      };
      const nodeHas = sha => require('tls').rootCertificates.some(p => new X509Certificate(p).fingerprint256.replace(/:/g, '') === sha.toUpperCase());
      const brewPrefix = (await brew.available(ctx)) ? (await brew.prefix(ctx)) : null;
      const distrusted = ctx.policy.distrusted_root || [];
      // Linux: the family's system bundle (parity 0.5); one that can't be found is said, never taken for "not in"
      const bundle = ctx.platform === 'linux' ? systemBundle(ctx) : null;
      if (ctx.platform === 'linux' && !bundle && distrusted.length) out.note(`system CA bundle not found (looked in ${[...new Set(Object.values(SYSTEM_BUNDLE))].join(', ')}); distrusted roots there were not checked`);
      for (const r of distrusted) {
        if (ctx.platform === 'macos') {
          const roots = (await ctx.run('security', ['find-certificate', '-a', '-Z', '-c', r.name, '/System/Library/Keychains/SystemRootCertificates.keychain'])).stdout;
          if (roots.toLowerCase().includes(`sha-256 hash: ${r.sha256.toLowerCase()}`)) {
            const settings = (await ctx.run('security', ['dump-trust-settings', '-d'])).stdout;
            let hit = false, deny = false;
            for (const l of settings.split('\n')) { if (/^Cert [0-9]+:/.test(l)) hit = l.includes(r.name); if (hit && l.includes('ResultDeny')) deny = true; }
            if (deny) out.ok(`${r.name} (${r._source}): in macOS system roots, admin trust setting = Deny`);
            else out.action(`trust: ${r.name} is trusted by macOS; deny it: sudo security add-trusted-cert -d -r deny <pem> (see AGENTS.md)`);
          } else out.ok(`${r.name} (${r._source}): not in macOS system roots`);
          if (pemHas('/etc/ssl/cert.pem', r.sha256)) out.info(`${r.name}: still in /etc/ssl/cert.pem (Apple-managed; leaves with a macOS update)`);
        } else if (bundle) {
          if (pemHas(bundle, r.sha256)) out.action(`trust: ${r.name} is in the system bundle ${bundle}; distrust it by hand for now (parity 2.1 adds the family's own command)`, { fix: FIX.trustLinux });
          else out.ok(`${r.name} (${r._source}): not in the system bundle ${bundle}`);
        }
        if (brewPrefix && pemHas(path.join(brewPrefix, 'etc', 'ca-certificates', 'cert.pem'), r.sha256)) out.action(`trust: ${r.name} in Homebrew ca-certificates: brew upgrade ca-certificates`);
        if (nodeHas(r.sha256)) out.action(`trust: ${r.name} in Node ${process.version}'s bundled roots: steward sc node-patch <fixed version>`);
      }
    },
  },
  {
    id: 'docker', name: 'Docker', platforms: ALL, title: () => 'Docker',
    async run(ctx, out) {
      detail(ctx, 'docker info');
      if ((await ctx.run('docker', ['info'])).status !== 0) { out.line('docker not running: skipped'); return; }
      for (const l of (await ctx.run('docker', ['ps', '--format', '{{.Image}}\t{{.Names}}'])).stdout.split('\n').filter(Boolean)) {
        const [image, name] = l.split('\t');
        if (image.includes('@sha256:')) continue;
        if (image.endsWith(':latest') || !image.slice(image.lastIndexOf('/') + 1).includes(':')) out.action(`docker: container ${name} runs floating ${image}; pin tag@digest`, { fix: FIX.docker, name, have: image });
        else out.info(`${name}: ${image} (tag, no digest)`);
      }
    },
  },
  {
    id: 'ioc', name: 'Indicators of compromise', platforms: ALL, title: () => "Indicators of compromise (ioc: the engine's defaults and yours; read-only)",
    async run(ctx, out) {
      const roots = [path.join(ctx.cfg.paths.mise_data_dir, 'installs', 'python'), path.join(ctx.home, '.local', 'share', 'uv'),
        ...((await brew.available(ctx)) ? [path.join((await brew.prefix(ctx)), 'lib')] : []), ...pythonRoots(ctx), ...((ctx.cfg.ioc && ctx.cfg.ioc.extra_roots) || [])];
      detail(ctx, 'docker images');
      const dockerUp = (await ctx.run('docker', ['info'])).status === 0;
      const digests = dockerUp ? (await ctx.run('docker', ['images', '--digests', '--format', '{{.Digest}}'])).stdout : '';
      // every process but this audit's own (its command line could hold a pattern only as an argument)
      const ps = await processes(ctx);
      // what the sweep can see here, in one format on every platform (parity 0.4): a gap is named, never silent
      const envSeen = ps.error ? `✗ (${ps.error})` : ctx.platform === 'linux' ? '✓ (your processes; others need root)' : ctx.platform === 'macos' ? "✗ (macOS doesn't show them)" : '✗ (not on this platform)';
      const folders = roots.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }).length;
      out.note(`coverage here: files ✓ · command lines ${ps.error ? `✗ (${ps.error})` : '✓'} · environments ${envSeen} · Python packages ${folders ? `✓ (${folders} folder${folders === 1 ? '' : 's'})` : '✗ (no Python folders found)'} · Docker images ${dockerUp ? '✓' : '✗ (not running)'}`);
      const iocs = ctx.policy.ioc || [];
      if (ps.error && iocs.some(i => [...(i.processes || []), ...(i.environment || [])].some(Boolean))) out.action(`ioc: the process list couldn't be read (${ps.error}); process indicators were not checked`, { fix: FIX.processList });
      for (const i of iocs) {
        let hits = 0;
        const unchecked = new Set();
        for (const f of i.files || []) if (f && fs.existsSync(f)) { out.alert(`${i.name}: file present ${f}`); hits++; }
        // processes: words in a command line; environment: variables in a process's environment (Linux only)
        for (const p of i.processes || []) {
          if (!p) continue;
          if (ps.error) { unchecked.add(`processes (${ps.error})`); continue; }
          if (ps.list.some(x => x.cmd.includes(p))) { out.alert(`${i.name}: process matching '${p}'`); hits++; }
        }
        for (const m of i.environment || []) {
          if (!m) continue;
          if (ps.error) { unchecked.add(`environment (${ps.error})`); continue; }
          if (ctx.platform !== 'linux') { unchecked.add(`environment (${ctx.platform === 'macos' ? "macOS doesn't show process environments" : 'this platform shows no process environments'})`); continue; }
          const hit = ps.list.find(x => x.env && x.env.includes(m));
          if (hit) { out.alert(`${i.name}: process environment matching '${m}' (pid ${hit.pid})`); hits++; }
        }
        for (const f of i.site_packages_files || []) {
          if (!f) continue;
          detail(ctx, `${i.name}: site-packages`);
          // 9: how deep Python nests site-packages under these roots (installs/python/<ver>/lib/python3.x/site-packages/…)
          // site-packages, or dist-packages where Debian and Ubuntu put a system Python's packages
          const found = (await ctx.run('find', [...roots, '-maxdepth', '9', '(', '-path', `*/site-packages/${f}`, '-o', '-path', `*/dist-packages/${f}`, ')', '-not', '-path', '*/node_modules/*'])).stdout.split('\n').filter(Boolean).slice(0, 3);
          if (found.length) { out.alert(`${i.name}: ${found.join(', ')}`); hits++; }
        }
        for (const d of i.docker_digests || []) if (d && digests.includes(d)) { out.alert(`${i.name}: docker image with digest ${d}`); hits++; }
        if (!hits && unchecked.size) out.note(`${i.name} (${i._source}): not fully checked: ${[...unchecked].join('; ')}`);
        else if (!hits) out.clean(`${i.name} (${i._source})`);
      }
    },
  },
  {
    // Known vulnerabilities (D69, lib/vulns.js): what's installed against the [[advisory_feed]] feeds. High, critical,
    // unrated and known-exploited findings are actions; the rest are listed. A package inside a tool is fixed by that
    // tool's next release, so a tool's serious ones make one action. A feed that couldn't be read is said, never clean
    id: 'vulns', name: 'Known vulnerabilities', platforms: ALL,
    title: () => 'Known vulnerabilities (advisory_feed: the engine\'s defaults and yours; read-only; steward sc vulns)',
    async run(ctx, out) {
      const feeds = ctx.policy.advisory_feed || [];
      if (!feeds.length) { out.action('vuln-feed: every advisory_feed is turned off in host.toml, so nothing was checked'); return; }
      detail(ctx, 'mise ls --json, and the packages inside each tool');
      const s = ctx.policy.vulns || V.SETTINGS;
      const inv = await V.inventory(ctx, s, { say: t => detail(ctx, t) });
      const { findings, failed, checked } = await V.lookup(ctx, feeds, inv, t => detail(ctx, t), s);
      const serious = f => V.serious(f, s);
      // the tools AI tooling owns: their fixes and any isolation are the ai-tooling skill's
      const owned = ctx.aiOwned || (ctx.cfg.profiles && ctx.cfg.profiles.ai_tooling ? V.aiOwned(require('../../lib/config.js').policy('ai-tooling/ai-tooling.toml')) : []);
      const isOwned = tool => owned.includes(tool) || owned.includes(tool.replace(/^npm -g /, ''));
      // isolate(tool, list) — the isolate command when a finding in list is urgent and the tool may be isolated, else ''
      const isolate = (tool, list) => (s.isolate_suggest && list.some(V.urgent) && !V.isolatable(tool, s, owned) ? `steward sc isolate ${tool}` : '');
      for (const f of failed) out.action(`vuln-feed: ${f.feed} not checked (${f.error}); what it would have found is missing`, { fix: 'check the network or the feed, then steward sc vulns', name: f.feed, note: 'not checked' });
      for (const e of ctx.policy.advisory_ignore || []) if (String(e.expires) < ctx.today) out.info(`advisory_ignore ${e.id} (${e.name} ${e.version}) expired ${e.expires}: shown again`);
      const shown = [];
      for (const f of findings) {
        const e = V.ignored(f, ctx.policy.advisory_ignore, ctx.today);
        if (e) out.info(`ignored until ${e.expires}: ${f.id} in ${f.pkg.name} ${f.pkg.version} (${f.pkg.tool}): ${e.reason}`);
        else shown.push(f);
      }
      const nth = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
      const label = f => `${f.id} ${f.malicious ? 'MALICIOUS PACKAGE' : f.severity}${f.kev ? ', known exploited' : ''}${f.epss ? `, EPSS ${nth(Math.round(f.epss.percentile * 100))} percentile` : ''}`;
      const fixedText = f => (f.pkg.ecosystem === 'eol' ? `supported: ${(f.supported || []).join(', ') || 'see the link'}` : f.fixed ? `fixed in ${f.fixed}` : f.upstream ? 'fixed upstream, in no release yet' : 'no fixed release yet');
      const how = f => (f.pkg.ecosystem === 'Homebrew' ? (f.fixed ? 'steward sc plan, then steward sc upgrade (a security_exception of kind formula takes it before the gate)' : '')
        : f.pkg.ecosystem === 'eol' ? '' : V.fixCommand(f) || (f.fixed && f.pkg.tool.startsWith('npm -g ') ? 'steward sc install-hybrids (after its version in hybrids.toml)' : ''));
      // the tool itself (its own version, Node, a Homebrew formula, an end of life): one line per tool, its worst
      // advisory first, with the command that takes the fix (the highest fixed version they name)
      const own = shown.filter(f => f.pkg.top);
      for (const tool of [...new Set(own.map(f => f.pkg.tool))]) {
        const mine = own.filter(f => f.pkg.tool === tool);
        const f = mine[0];
        const fixed = mine.map(x => x.fixed).filter(Boolean).sort(V.cmpVer).pop() || '';
        const g = { ...f, fixed, upstream: !fixed && mine.some(x => x.upstream) };
        const owner = V.nodeOwn(tool) ? '; it ships with Node: a Node release carries the fix (steward sc plan)' : isOwned(tool) ? '; AI tooling owns it (the ai-tooling skill)' : '';
        const cmd = owner ? '' : how(g) || isolate(tool, mine);
        const more = mine.length > 1 ? ` and ${mine.length - 1} more (${mine.slice(1, 4).map(x => x.id).join(', ')}${mine.length > 4 ? ', …' : ''})` : '';
        const text = `vuln: ${tool} ${f.pkg.version}: ${label(f)}${more}, ${fixedText(g)} ${f.url}${owner}${cmd ? `: ${cmd}` : ''}`;
        if (mine.some(serious)) out.action(text, { fix: cmd || (f.pkg.ecosystem === 'eol' ? 'move to a supported release (a major is deliberate)' : 'read the advisory: no fixed release yet'), name: tool, have: f.pkg.version, want: fixed, note: label(f) });
        else out.info(text);
      }
      // packages inside a tool: listed one by one, and a tool's serious ones as one action
      const inside = shown.filter(f => !f.pkg.top);
      for (const f of inside) out.info(`${f.pkg.tool}: ${f.pkg.name} ${f.pkg.version} inside it: ${label(f)}, ${fixedText(f)} ${f.url}`);
      for (const tool of [...new Set(inside.filter(serious).map(f => f.pkg.tool))]) {
        const mine = inside.filter(f => f.pkg.tool === tool && serious(f));
        const ids = [...new Set(mine.map(f => f.id))];
        const pkgs = new Set(mine.map(f => `${f.pkg.name}@${f.pkg.version}`)).size;
        const owner = isOwned(tool) ? '; AI tooling owns it (the ai-tooling skill)' : '';
        const iso = owner || V.nodeOwn(tool) ? '' : isolate(tool, mine);
        const when = V.nodeOwn(tool) ? 'it ships with Node: a Node release carries the fixes (steward sc plan)' : 'update it when a release carries the fixes';
        out.action(`vuln: ${tool}: ${ids.length} serious advisor${ids.length === 1 ? 'y' : 'ies'} in ${pkgs} package(s) inside it (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''}); ${when} (steward sc vulns --verbose lists them)${owner}${iso ? `; exploited or critical with no fix: ${iso}` : ''}`,
          { fix: iso || 'update the tool that bundles it, when a release carries the fix', name: tool, note: `${ids.length} in ${pkgs} package(s)` });
      }
      if (shown.some(f => serious(f) && f.pkg.top && V.fixCommand(f) && !isOwned(f.pkg.tool))) (out.note || out.line)('steward sc vulns-fix takes every fix named above in one plan (and old installs that carry serious advisories)');
      for (const c of inv.coverage || []) if (c.failed) out.action(`vuln-feed: ${c.source} ${c.text}`); else (out.note || out.info)(`coverage: ${c.source === 'elsewhere' ? '' : `${c.source}: `}${c.text}`);
      if (inv.uncovered.length && s.list_not_covered) out.info(`not covered (no advisory ecosystem; not the same as clean): ${inv.uncovered.join(', ')}`);
      const nSerious = shown.filter(serious).length;
      const line = `${new Set(inv.packages.map(p => `${p.ecosystem}\0${p.name}\0${p.version}`)).size} package version(s) in ${inv.covered.length} tool(s), checked with ${checked.join(', ') || 'no feed'}: ${nSerious} serious (${s.action_severity} and up${s.exploited_always_action ? ', or exploited' : ''}), ${shown.length - nSerious} other`;
      if (shown.length) out.ok(line);
      else if (!failed.length) out.clean(line);
      else out.info(line);
    },
  },
];

module.exports = { CHECKS, ALL, FIX, caskIds, pickCask, verLt, appVersion, appBehind, ageDays, securityException, processes, pythonRoots, systemBundle, SYSTEM_BUNDLE };
