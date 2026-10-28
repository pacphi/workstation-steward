// The host audit's checks (R5c): each section of the former Bash audit as data, so a platform runs only the checks
// that apply to it and a package manager is a provider (lib/providers/). Read-only: a check reports, it never changes
// anything. Every command goes through ctx.run (async, so a live display keeps moving), so tests hand them canned output.
//   check: { id, name (the step's short name), title(ctx) (the plain output's header), platforms, async run(ctx, out) }
//   out:   line(text) (an indented line as it comes), ok/held/info/clean(text), action(text), alert(text)
// ctx: { run, cfg (lib/config.js values), policy (lib/host.js merged), instance, engine, cache, today, home, now,
//        platform, appDirs (where apps live; tests only) }
const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const brew = require('../../lib/providers/brew.js');

const ALL = ['macos', 'linux', 'windows'];
const DAY = 86400e3;

// ageDays(iso, now) — whole days since iso, or -1 when it doesn't parse (bash age_days)
const ageDays = (iso, now) => { const t = Date.parse(iso); return iso && !Number.isNaN(t) ? Math.floor((now - t) / DAY) : -1; };

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

// securityException(ctx, kind, name, version) — the advisory of an unexpired security_exception for that version
const securityException = (ctx, kind, name, version) => {
  const e = (ctx.policy.security_exception || []).find(x => x.kind === kind && x.name === name && x.version === version && x.expires >= ctx.today);
  return e ? e.advisory : '';
};

const minAge = ctx => ctx.cfg.policy.min_release_age_days;
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
      const [act, current, target, reason, auto] = (await ctx.run('node', [path.join(ctx.engine, 'supply-chain', 'bin', 'mise-self.js'), '--plan'])).stdout.trim().split('\t');
      if (act === 'take') out.action(`mise: ${current} -> ${target} (${reason}): steward sc upgrade-tool mise`);
      if (act === 'hold' && String(reason).includes('security_exception')) out.action(`mise: ${current} (${reason})`);
      if (auto === 'true') out.action('mise: self_update.auto is on; it replaces the binary without a backup or receipt: mise settings set self_update.auto false');
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
        else out.action(`${where} = ${val || 'unset'}, steward.toml says ${min} day(s) (steward sc release-age ${min})`);
      }
    },
  },
  {
    id: 'brew-formulae', name: 'Homebrew formulae', platforms: brew.platforms, provider: brew,
    title: ctx => `Homebrew formulae (live API; eligible = at least ${minAge(ctx)}d in homebrew-core, or a host.toml security exception)`,
    async run(ctx, out) {
      const min = minAge(ctx);
      for (const { name, have, want } of (await brew.outdated(ctx, 'formula'))) {
        const age = ageDays((await brew.releaseDate(ctx, 'formula', name, want)), ctx.now);
        const exc = securityException(ctx, 'formula', name, want.replace(/_[^_]*$/, ''));
        if (exc) out.action(`brew: ${name} ${have} -> ${want} (security exception: ${exc})`);
        else if (age >= min) out.action(`brew: ${name} ${have} -> ${want} (${age}d old)`);
        else out.held(`${name} ${have} -> ${want} (${age}d old; eligible in ${min - age}d)`);
      }
      for (const l of (await ctx.run('brew', ['outdated', '--formula', '--verbose'])).stdout.split('\n').filter(l => l.includes('/'))) out.line(`tap (as of last brew update): ${l}`);
    },
  },
  {
    id: 'brew-casks', name: 'Homebrew casks', platforms: ['macos'], provider: brew, title: () => 'Homebrew casks (casks that update themselves are judged by their app bundle below)',
    async run(ctx, out) {
      const min = minAge(ctx);
      for (const { name, have, want, auto } of (await brew.outdated(ctx, 'cask'))) {
        if (auto) continue;
        const age = ageDays((await brew.releaseDate(ctx, 'cask', name, want)), ctx.now);
        if (age >= min) out.action(`cask: ${name} ${have} -> ${want} (${age}d old)`);
        else out.held(`${name} ${have} -> ${want} (${age}d old)`);
      }
    },
  },
  {
    id: 'apps', name: 'Apps and Electron', platforms: ['macos'],
    title: ctx => `Apps (bundle version vs Homebrew cask catalog; Electron vs its ${ctx.policy.electron_supported_majors ?? 3} supported majors)`,
    async run(ctx, out) {
      const min = minAge(ctx), majors = ctx.policy.electron_supported_majors ?? 3;
      const byApp = new Map();
      for (const c of (await brew.api(ctx, 'cask'))) for (const a of c.artifacts || []) for (const app of [].concat((a && a.app) || [])) {
        if (typeof app === 'string' && !byApp.has(app)) byApp.set(app, { token: c.token, want: String(c.version).split(',')[0] });
      }
      const always = new Set(ctx.policy.always_current || []);
      const latest = (await ctx.run('npm', ['view', 'electron', 'dist-tags.latest'])).stdout.trim() || '0';
      const electronMin = parseInt(latest, 10) - majors + 1;
      const plist = async (f, key) => (await ctx.run('defaults', ['read', f, key])).stdout.trim();
      const apps = [];
      for (const dir of ctx.appDirs || ['/Applications', path.join(ctx.home, 'Applications')]) {
        let names = [];
        try { names = fs.readdirSync(dir).filter(n => n.endsWith('.app')).sort(); } catch { /* none */ }
        for (const n of names) apps.push(path.join(dir, n));
      }
      for (const app of apps) {
        if (!fs.statSync(app).isDirectory() || fs.existsSync(path.join(app, 'Contents', '_MASReceipt'))) continue; // App Store apps: below
        const base = path.basename(app), short = base.replace(/\.app$/, '');
        const have = (await plist(path.join(app, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'));
        const ep = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist');
        if (fs.existsSync(ep)) {
          const ev = (await plist(ep, 'CFBundleVersion')) || '0';
          if (parseInt(ev, 10) < electronMin) out.action(`app: ${short} bundles Electron ${ev} (supported: ${electronMin}+); update it, or ask the vendor`);
        }
        const c = byApp.get(base);
        if (!c || !have) continue;
        let cmp = have.split(' ')[0];
        // Chromium-based apps prefix the Chromium major (Brave 153.1.95.104 vs cask 1.95.104)
        if (parseInt(cmp, 10) > 100 && parseInt(c.want, 10) < 10) cmp = cmp.slice(cmp.indexOf('.') + 1);
        if (!verLt(cmp, c.want)) continue;
        const age = ageDays((await brew.releaseDate(ctx, 'cask', c.token, c.want)), ctx.now);
        if (always.has(c.token)) out.action(`app: ${short} ${have} -> ${c.want} (${age}d old; always_current: update now)`);
        else if (age >= min || age < 0) out.action(`app: ${short} ${have} -> ${c.want} (${age}d old; vendor updater; matched cask ${c.token} by app name)`);
        else out.held(`${short} ${have} -> ${c.want} (${age}d old; matched cask ${c.token})`);
      }
    },
  },
  {
    id: 'app-store', name: 'App Store', platforms: ['macos'], title: () => 'App Store (mas)',
    async run(ctx, out) {
      if ((await ctx.run('mas', ['version'])).status !== 0) { out.warn('mas not installed (brew install mas): App Store not checked'); return; }
      const lines = (await ctx.run('mas', ['outdated'], { label: 'mas outdated' })).stdout.split('\n').filter(Boolean);
      if (lines.length) for (const l of lines) out.action(`appstore: ${l}`); else out.line('up to date');
    },
  },
  {
    id: 'macos', name: 'macOS updates', platforms: ['macos'], title: () => 'macOS (softwareupdate -l)',
    async run(ctx, out) {
      const r = (await ctx.run('softwareupdate', ['-l'], { label: "softwareupdate -l (Apple's server can take a minute)", stderr: true }));
      const labels = r.stdout.split('\n').filter(l => /^\s*\* Label:/.test(l));
      if (labels.length) for (const l of labels) out.action(`macOS: ${l.slice(l.indexOf('Label: ') + 7)}`);
      else out.line(`${(await ctx.run('sw_vers', ['-productVersion'])).stdout.trim()}: no updates`);
    },
  },
  {
    id: 'trust', name: 'Trust stores', platforms: ['macos'], title: () => "Trust stores (distrusted_root: the engine's defaults and yours)",
    async run(ctx, out) {
      const pemHas = (file, sha) => {
        let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
        return (text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []).some(p => new X509Certificate(p).fingerprint256.replace(/:/g, '') === sha.toUpperCase());
      };
      const nodeHas = sha => require('tls').rootCertificates.some(p => new X509Certificate(p).fingerprint256.replace(/:/g, '') === sha.toUpperCase());
      const brewPrefix = (await brew.available(ctx)) ? (await brew.prefix(ctx)) : null;
      for (const r of ctx.policy.distrusted_root || []) {
        const roots = (await ctx.run('security', ['find-certificate', '-a', '-Z', '-c', r.name, '/System/Library/Keychains/SystemRootCertificates.keychain'])).stdout;
        if (roots.toLowerCase().includes(`sha-256 hash: ${r.sha256.toLowerCase()}`)) {
          const settings = (await ctx.run('security', ['dump-trust-settings', '-d'])).stdout;
          let hit = false, deny = false;
          for (const l of settings.split('\n')) { if (/^Cert [0-9]+:/.test(l)) hit = l.includes(r.name); if (hit && l.includes('ResultDeny')) deny = true; }
          if (deny) out.ok(`${r.name} (${r._source}): in macOS system roots, admin trust setting = Deny`);
          else out.action(`trust: ${r.name} is trusted by macOS; deny it: sudo security add-trusted-cert -d -r deny <pem> (see AGENTS.md)`);
        } else out.ok(`${r.name} (${r._source}): not in macOS system roots`);
        if (pemHas('/etc/ssl/cert.pem', r.sha256)) out.info(`${r.name}: still in /etc/ssl/cert.pem (Apple-managed; leaves with a macOS update)`);
        if (brewPrefix && pemHas(path.join(brewPrefix, 'etc', 'ca-certificates', 'cert.pem'), r.sha256)) out.action(`trust: ${r.name} in Homebrew ca-certificates: brew upgrade ca-certificates`);
        if (nodeHas(r.sha256)) out.action(`trust: ${r.name} in Node ${process.version}'s bundled roots: steward sc node-patch <fixed version>`);
      }
    },
  },
  {
    id: 'docker', name: 'Docker', platforms: ALL, title: () => 'Docker',
    async run(ctx, out) {
      if ((await ctx.run('docker', ['info'])).status !== 0) { out.line('docker not running: skipped'); return; }
      for (const l of (await ctx.run('docker', ['ps', '--format', '{{.Image}}\t{{.Names}}'])).stdout.split('\n').filter(Boolean)) {
        const [image, name] = l.split('\t');
        if (image.includes('@sha256:')) continue;
        if (image.endsWith(':latest') || !image.slice(image.lastIndexOf('/') + 1).includes(':')) out.action(`docker: container ${name} runs floating ${image}; pin tag@digest`);
        else out.info(`${name}: ${image} (tag, no digest)`);
      }
    },
  },
  {
    id: 'ioc', name: 'Indicators of compromise', platforms: ALL, title: () => "Indicators of compromise (ioc: the engine's defaults and yours; read-only)",
    async run(ctx, out) {
      const roots = [path.join(ctx.cfg.paths.mise_data_dir, 'installs', 'python'), path.join(ctx.home, '.local', 'share', 'uv'),
        ...((await brew.available(ctx)) ? [path.join((await brew.prefix(ctx)), 'lib')] : []), ...((ctx.cfg.ioc && ctx.cfg.ioc.extra_roots) || [])];
      const dockerUp = (await ctx.run('docker', ['info'])).status === 0;
      const digests = dockerUp ? (await ctx.run('docker', ['images', '--digests', '--format', '{{.Digest}}'])).stdout : '';
      // every process but this audit's own (its command line could hold a pattern only as an argument)
      const ps = (await ctx.run('ps', ['-axeww', '-o', 'pid=,command='])).stdout.split('\n').filter(l => Number(l.trim().split(/\s/)[0]) !== process.pid);
      for (const i of ctx.policy.ioc || []) {
        let hits = 0;
        for (const f of i.files || []) if (f && fs.existsSync(f)) { out.alert(`${i.name}: file present ${f}`); hits++; }
        for (const p of i.processes || []) if (p && ps.some(l => l.includes(p))) { out.alert(`${i.name}: process matching '${p}'`); hits++; }
        for (const f of i.site_packages_files || []) {
          if (!f) continue;
          // 9: how deep Python nests site-packages under these roots (installs/python/<ver>/lib/python3.x/site-packages/…)
          const found = (await ctx.run('find', [...roots, '-maxdepth', '9', '-path', `*/site-packages/${f}`, '-not', '-path', '*/node_modules/*'])).stdout.split('\n').filter(Boolean).slice(0, 3);
          if (found.length) { out.alert(`${i.name}: ${found.join(', ')}`); hits++; }
        }
        for (const d of i.docker_digests || []) if (d && digests.includes(d)) { out.alert(`${i.name}: docker image with digest ${d}`); hits++; }
        if (!hits) out.clean(`${i.name} (${i._source})`);
      }
    },
  },
];

module.exports = { CHECKS, ALL, verLt, ageDays, securityException };
