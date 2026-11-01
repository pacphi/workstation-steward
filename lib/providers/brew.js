// Homebrew as a provider (R5c): what is installed and outdated, judged against Homebrew's live API (the local cache
// only refreshes on `brew update`), and when a version landed (the release-age gate). Formulae and casks are its two
// kinds. Homebrew cleans up old kegs on upgrade, so it can't roll back. Runs on macOS, and on Linux as Linuxbrew
// (formulae only). The same logic as the Bash helpers it replaced (brew_api, brew_outdated, brew_version_date).
// Every command goes through ctx.run (async), so tests hand it canned output.
const fs = require('fs');
const path = require('path');

const id = 'brew';
const platforms = ['macos', 'linux'];
const canRollback = false;

const available = async ctx => (await ctx.run('brew', ['--prefix'])).status === 0;
const prefix = async ctx => (await ctx.run('brew', ['--prefix'])).stdout.trim();

// api(ctx, kind) — Homebrew's live JSON list for formula|cask, downloaded once a day into the cache
async function api(ctx, kind) {
  const f = path.join(ctx.cache, `${kind}-${ctx.today.replace(/-/g, '')}.json`);
  if (!(fs.existsSync(f) && fs.statSync(f).size)) {
    fs.mkdirSync(ctx.cache, { recursive: true });
    const r = (await ctx.run('curl', ['-fsSL', `https://formulae.brew.sh/api/${kind}.json`, '-o', f], { label: `download Homebrew's ${kind} list` }));
    if (r.status !== 0) throw new Error(`could not download Homebrew's ${kind} list`);
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// installed(ctx, kind) — [{name, version}]: formulae from homebrew-core only (a tap's formula can share a core name),
// or every cask
async function installed(ctx, kind) {
  const lines = (await ctx.run('brew', ['list', `--${kind}`, '--versions'])).stdout.split('\n').filter(Boolean);
  const taps = new Set(kind === 'formula' ? (await ctx.run('brew', ['list', '--formula', '--full-name'])).stdout.split('\n').filter(l => l.includes('/')).map(l => l.slice(l.lastIndexOf('/') + 1)) : []);
  return lines.map(l => l.split(' ')).filter(p => !taps.has(p[0])).map(p => ({ name: p[0], version: p[p.length - 1] }));
}

// outdated(ctx, kind) — [{name, have, want, auto}]: installed packages whose API version differs (auto: a cask that
// updates itself, judged by its app bundle instead)
async function outdated(ctx, kind) {
  const want = new Map();
  for (const p of (await api(ctx, kind))) {
    const v = kind === 'formula' ? p.versions.stable + (p.revision ? `_${p.revision}` : '') : String(p.version);
    want.set(kind === 'formula' ? p.name : p.token, [v, Boolean(p.auto_updates)]);
  }
  return (await installed(ctx, kind)).flatMap(({ name, version }) => {
    const hit = want.get(name);
    return hit && hit[0] !== version ? [{ name, have: version, want: hit[0], auto: hit[1] }] : [];
  });
}

// releaseDate(ctx, kind, name, version) — when that version landed in homebrew-core or homebrew-cask (the newest of the
// last 30 commits to its file whose message names it), or '' when unknown
async function releaseDate(ctx, kind, name, version) {
  const v = String(version).split(',')[0].replace(/_[^_]*$/, '');
  const repo = kind === 'formula' ? 'Homebrew/homebrew-core' : 'Homebrew/homebrew-cask';
  const file = kind === 'formula'
    ? (name.startsWith('lib') ? `Formula/lib/${name}.rb` : `Formula/${name[0]}/${name}.rb`)
    : (name.startsWith('font-') ? `Casks/font/font-${name[5]}/${name}.rb` : `Casks/${name[0]}/${name}.rb`);
  const r = (await ctx.run('gh', ['api', `repos/${repo}/commits?path=${file}&per_page=30`, '--jq', `[.[] | select(.commit.message | contains("${v}")) | .commit.committer.date] | last // ""`]));
  return r.status === 0 ? r.stdout.trim() : '';
}

// The two package sources Homebrew gives (lib/providers/index.js, parity 0.2). Homebrew keeps no old keg to roll back to
// (brew upgrade cleans up), so its way back is a reinstall; it refreshes its metadata once, with the formulae.
const back = 'brew reinstall the previous bottle (Homebrew keeps no old keg; brew named what failed above)';
const source = (kind, o) => ({
  provider: id, families: null, gateMode: 'per-package', needsRoot: false, back,
  available, outdated: ctx => outdated(ctx, kind), releaseDate: (ctx, name, want) => releaseDate(ctx, kind, name, want),
  upgradeCmd: names => ({ cmd: 'brew', args: ['upgrade', `--${kind}`, ...names] }), ...o,
});
const formula = source('formula', {
  id: 'brew-formula', check: 'brew-formulae', name: 'Homebrew formulae', title: 'Homebrew formulae', noun: 'formula(e)', tag: 'brew', platforms,
  exceptionKind: 'formula', exceptionVersion: want => want.replace(/_[^_]*$/, ''), heldEta: true,
  refresh: () => ({ cmd: 'brew', args: ['update', '--quiet'] }),
  // a tap's formula isn't in the live API: its line from brew's own record, to review by hand
  manual: async ctx => (await ctx.run('brew', ['outdated', '--formula', '--verbose'])).stdout.split('\n').filter(l => l.includes('/')),
  manualText: (where, l) => (where === 'plan' ? `manual tap formula (review its release, then brew upgrade): ${l}` : `tap (as of last brew update): ${l}`),
});
const cask = source('cask', {
  id: 'brew-cask', check: 'brew-casks', name: 'Homebrew casks', title: 'Homebrew casks (self-updating casks are left to their own updaters)', noun: 'cask(s)', tag: 'cask',
  platforms: ['macos'], exceptionKind: null, exceptionVersion: null, heldEta: false, refresh: () => null, manual: async () => [], manualText: (_w, l) => l,
});

module.exports = { id, platforms, canRollback, available, prefix, api, installed, outdated, releaseDate, formula, cask };
