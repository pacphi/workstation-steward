// The package sources (parity 0.2): every provider and kind of package (Homebrew formulae and casks; apt, dnf and zypper
// next) is one object with one contract, so the audit (supply-chain/checks/) and the plan (supply-chain/bin/upgrade.js)
// judge a package the same way, here. mise is not a source: it applies the release-age gate itself and keeps its own
// path (bin/upgrade-tool, node-patch, the tools AI tooling owns).
//   source: { id, check (the audit check's id), provider (what "<provider> not found" names), title (the plan's
//             section), noun (the plan's count), tag (the audit's line prefix), platforms, families (D63; null: any),
//             gateMode ('per-package' | 'snapshot', D-a), exceptionKind (host.toml security_exception kind, or null),
//             exceptionVersion(want) (the version an exception names), needsRoot (D-b: never run by the steward),
//             heldEta (the audit's held line says when it is eligible), back (the way back when its upgrade fails),
//             async available(ctx), refresh() → {cmd, args} | null, async outdated(ctx) → [{name, have, want, auto}],
//             async releaseDate(ctx, name, want) → ISO date | '', async manual(ctx) → [line],
//             upgradeCmd(names) → {cmd, args} }
const PL = require('../platform.js');
const brew = require('./brew.js');

const DAY = 86400e3;
// every source, in the order the plan and the audit show them
const ALL = [brew.formula, brew.cask];

// ageDays(iso, now) — whole days since iso, or -1 when it doesn't parse (bash age_days)
const ageDays = (iso, now) => { const t = Date.parse(iso); return iso && !Number.isNaN(t) ? Math.floor((now - t) / DAY) : -1; };

// securityException(ctx, kind, name, version) — the advisory of an unexpired security_exception for that version
const securityException = (ctx, kind, name, version) => {
  const e = (ctx.policy.security_exception || []).find(x => x.kind === kind && x.name === name && x.version === version && x.expires >= ctx.today);
  return e ? e.advisory : '';
};

// sources(ctx) — the sources whose platforms and families hold here (ctx.sources stands in for ALL in tests)
const sources = ctx => (ctx.sources || ALL).filter(s => PL.applies(s, ctx.platform, ctx.family === undefined ? null : ctx.family));

// byId(id, list) — a source by its id, or null
const byId = (id, list = ALL) => list.find(s => s.id === id) || null;

// judge(ctx, source, item) — {verdict: 'take' | 'hold', age, exception}: an unexpired security exception for the version
// is taken whatever its age; otherwise it is taken once it is at least the release-age gate's days old, and held before
// that or when its date is unknown (age -1)
/** @param {any} ctx @param {any} source @param {{ name: string, have?: string, want: string, auto?: boolean }} item */
async function judge(ctx, source, item) {
  const { name, want } = item;
  const age = ageDays(await source.releaseDate(ctx, name, want), ctx.now);
  const exception = source.exceptionKind ? securityException(ctx, source.exceptionKind, name, source.exceptionVersion ? source.exceptionVersion(want) : want) : '';
  return { verdict: exception || age >= ctx.cfg.policy.min_release_age_days ? 'take' : 'hold', age, exception };
}

module.exports = { ALL, sources, byId, judge, ageDays, securityException };
