// Package sources for known vulnerabilities (D70): each says what is installed, in which advisory ecosystem, and how
// much it could read. lib/vulns.js's inventory runs them; a new package manager adds one here (docs/vulnerabilities.md,
// "Add a source"). Every command goes through ctx.run, so tests hand them canned output. Read-only.
//   goBinaries  Go programs carry the list of modules they were built from (`go version -m`), so a tool installed
//               as a plain binary (mise's core, aqua and github backends) is checked module by module, with Go itself
//   homebrew    Homebrew 7's own `brew vulns --json`: it matches formulae against OSV.dev and knows the patches
//               Homebrew applies, which no outside matcher can; it reports what it skipped
//   macos       the macOS version, for the end-of-life feed
const fs = require('fs');
const path = require('path');

// purl(ecosystem, name, version) — the package's Package-URL (ECMA-427), the one name every source and output shares
const PURL_TYPE = { npm: 'npm', PyPI: 'pypi', 'crates.io': 'cargo', Go: 'golang', Homebrew: 'brew' };
function purl(ecosystem, name, version) {
  const type = PURL_TYPE[ecosystem];
  if (!type) return '';
  const enc = s => encodeURIComponent(s).replace(/%2F/g, '/');
  const nm = type === 'npm' && name.startsWith('@') ? `%40${enc(name.slice(1))}` : type === 'pypi' ? enc(name.toLowerCase().replace(/[-_.]+/g, '-')) : enc(name);
  const v = type === 'golang' && name !== 'stdlib' ? `v${String(version).replace(/^v/, '')}` : version;
  return `pkg:${type}/${nm}@${encodeURIComponent(v)}`;
}

// buildInfo(text) — {go, main, deps: [{name, version}]} from `go version -m` output; null when it isn't a Go program
function buildInfo(text) {
  const lines = String(text || '').split('\n');
  const m = (lines[0] || '').match(/:\s+go(\d+\.\d+(?:\.\d+)?)/);
  if (!m) return null;
  const out = { go: m[1], main: null, deps: [] };
  for (const l of lines.slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f[0] === 'mod' && f[1]) out.main = { name: f[1], version: f[2] };
    else if (f[0] === 'dep' && f[1] && f[2]) out.deps.push({ name: f[1], version: f[2] });
    else if (f[0] === '=>' && f[1] && f[2] && out.deps.length) out.deps[out.deps.length - 1] = { name: f[1], version: f[2] };   // a replace directive
  }
  return out;
}

// executables(dir) — the executable files of a tool's install folder, up to three folders down (an unpacked release
// archive keeps its own folder: gh_2.103.3_macOS_arm64/bin/gh, darwin-arm64/helm). Links aren't followed, and
// dependency or source trees aren't searched; at most 20 files
const SKIP = new Set(['node_modules', 'lib', 'share', 'include', 'src', 'man', 'doc', 'docs', '.git']);
function executables(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 20) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3 && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(f, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(f); if (st.mode & 0o111 && st.size > 1e5) out.push(f); } catch { /* unreadable */ }
    }
  };
  walk(dir, 0);
  return out;
}

// goBinaries(ctx, installs, o) — {packages, read: [tool]}: for each install {tool, version, dir} with no package
// ecosystem, the modules of every Go program in it (ecosystem Go; Go's standard library as `stdlib`). o: {go (the go
// command), say, parallel}. A tool with no Go program in it is left for the caller to list as not covered
async function goBinaries(ctx, installs, o = {}) {
  const go = o.go || 'go';
  const packages = [], read = [];
  const n = o.parallel || 8;
  for (let i = 0; i < installs.length; i += n) {
    await Promise.all(installs.slice(i, i + n).map(async inst => {
      if (o.say) o.say(`${inst.tool} ${inst.version}: Go build info`);
      let found = false;
      for (const f of executables(inst.dir)) {
        const r = await ctx.run(go, ['version', '-m', f]);
        const b = r.status === 0 ? buildInfo(r.stdout) : null;
        if (!b) continue;
        found = true;
        const top = b.main && b.main.version && b.main.version !== '(devel)' ? b.main : b.main ? { name: b.main.name, version: inst.version } : null;
        if (top) packages.push({ ecosystem: 'Go', name: top.name, version: String(top.version).replace(/^v/, ''), tool: inst.tool, top: true, via: 'go build info' });
        packages.push({ ecosystem: 'Go', name: 'stdlib', version: b.go, tool: inst.tool, top: false, via: 'go build info' });
        for (const d of b.deps) packages.push({ ecosystem: 'Go', name: d.name, version: String(d.version).replace(/^v/, ''), tool: inst.tool, top: false, via: 'go build info' });
      }
      if (found) read.push(inst.tool);
    }));
  }
  return { packages, read };
}

// homebrew(ctx, o) — {hits: [{pkg, record}], coverage: {checked, skipped, complete}, error}: Homebrew's `brew vulns
// --json`, one hit per formula and advisory, in the shape lookup gives an OSV record. null when Homebrew isn't here
const SEV = { CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'moderate', MODERATE: 'moderate', LOW: 'low' };
async function homebrew(ctx, o = {}) {
  if ((await ctx.run('brew', ['--version'])).status !== 0) return null;
  if (o.say) o.say('Homebrew: brew vulns (its own check against OSV.dev)');
  const r = await ctx.run('brew', ['vulns', '--json']);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* no JSON */ }
  if (!j || !Array.isArray(j.findings)) return { hits: [], coverage: null, error: r.status === 127 ? 'brew vulns is not available (Homebrew 7 or later has it)' : 'brew vulns gave no JSON' };
  const cmp = o.cmpVer || ((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  const hits = [];
  for (const f of j.findings) {
    const pkg = { ecosystem: 'Homebrew', name: f.formula, version: String(f.version), tool: `brew ${f.formula}`, top: true };
    for (const v of f.vulnerabilities || []) {
      // a fix brew vulns names as a commit (40 hex digits) is upstream but not in any release yet
      const all = v.fixed_versions || [];
      const fixed = all.filter(x => !/^[0-9a-f]{40}$/.test(x) && cmp(x, pkg.version) > 0).sort(cmp)[0] || '';
      hits.push({ pkg, record: { id: v.id, aliases: v.aliases || [], summary: v.summary || '', _severity: SEV[String(v.severity).toUpperCase()] || 'unknown', _fixed: fixed,
        ...(!fixed && all.some(x => /^[0-9a-f]{40}$/.test(x)) ? { _upstream: true } : {}) } });
    }
  }
  const skipped = j.skipped_formulae || [];
  return { hits, coverage: { checked: j.checked || 0, skipped, complete: Boolean(j.complete) }, error: '' };
}

// macos(ctx) — the macOS version (sw_vers), or '' elsewhere
async function macos(ctx) {
  if (ctx.platform !== 'macos') return '';
  const r = await ctx.run('sw_vers', ['-productVersion']);
  return r.status === 0 ? r.stdout.trim() : '';
}

module.exports = { purl, buildInfo, executables, goBinaries, homebrew, macos };
