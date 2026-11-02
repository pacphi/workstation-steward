// Feeds that add to what OSV, nodejs.org and KEV say (D70). Data only, read with curl through ctx.run; lib/vulns.js's
// lookup calls them by [[advisory_feed]] kind. A new feed adds a kind here (docs/vulnerabilities.md, "Add a feed").
//   epss  FIRST's Exploit Prediction Scoring System: the chance a CVE is exploited in the next 30 days, daily, for
//         ranking the findings (and, with [vulns] epss_action_percentile, making a likely one an action)
//   eol   endoflife.date: a runtime, database or OS cycle past its end of life gets no security fixes at all, which no
//         CVE feed can say
const json = r => { if (!r || r.status !== 0) return null; try { return JSON.parse(r.stdout); } catch { return null; } };
const get = (ctx, url, s) => ctx.run('curl', ['-fsS', '-m', String(s.timeout_seconds), url]);

// epss(ctx, feed, findings, s) — {error}: each finding with a CVE (its id or an alias) gets epss {score, percentile}
async function epss(ctx, feed, findings, s) {
  const base = (feed.url || 'https://api.first.org/data/v1/epss').replace(/\/+$/, '');
  const cveOf = f => [f.id, ...f.aliases].find(x => /^CVE-\d{4}-\d+$/.test(x));
  const cves = [...new Set(findings.map(cveOf).filter(Boolean))];
  const scores = new Map();
  for (let i = 0; i < cves.length; i += 100) {
    const j = json(await get(ctx, `${base}?cve=${cves.slice(i, i + 100).join(',')}`, s));
    if (!j || !Array.isArray(j.data)) return { error: `${base} gave no answer` };
    for (const d of j.data) scores.set(d.cve, { score: Number(d.epss), percentile: Number(d.percentile), date: d.date });
  }
  for (const f of findings) { const c = cveOf(f); if (c && scores.has(c)) f.epss = scores.get(c); }
  return { error: '' };
}

// PRODUCTS — mise tool → endoflife.date product. A tool whose version names its vendor (java liberica-25…) maps by
// that prefix. Add a line to cover a runtime more (endoflife.date/api/all.json lists the products)
const PRODUCTS = {
  node: 'nodejs', python: 'python', postgres: 'postgresql', go: 'go', ruby: 'ruby', php: 'php', kubectl: 'kubernetes',
  terraform: 'terraform', dotnet: 'dotnet', deno: 'deno', bun: 'bun', rust: 'rust', redis: 'redis', mysql: 'mysql',
  perl: 'perl', erlang: 'erlang', elixir: 'elixir', kotlin: 'kotlin', scala: 'scala', gradle: 'gradle', lua: 'lua', // bsd-ok: perl is an endoflife.date product, not a command
  java: { liberica: 'bellsoft-liberica', temurin: 'eclipse-temurin', oracle: 'oracle-jdk', corretto: 'amazon-corretto', zulu: 'azul-zulu' },
};
// productOf(tool, version) — {product, version} for a tool endoflife.date tracks, else null
function productOf(tool, version) {
  const p = PRODUCTS[tool];
  if (!p) return null;
  if (typeof p === 'string') return { product: p, version: String(version) };
  const m = String(version).match(/^([a-z]+)-(.+)$/);
  return m && p[m[1]] ? { product: p[m[1]], version: m[2] } : null;
}
// cycleOf(cycles, version) — the cycle a version belongs to: the longest cycle name that is the version or a prefix of
// it at a dot (3.15 for 3.15.2; 26 for 26.12.1)
function cycleOf(cycles, version) {
  const v = String(version);
  return cycles.filter(c => v === String(c.cycle) || v.startsWith(`${c.cycle}.`)).sort((a, b) => String(b.cycle).length - String(a.cycle).length)[0] || null;
}

// eol(ctx, feed, inv, s) — {hits, error}: a hit for each installed runtime (inv.installs) or macOS (inv.os) whose cycle
// is past its end of life on ctx.today
async function eol(ctx, feed, inv, s) {
  const base = (feed.url || 'https://endoflife.date/api').replace(/\/+$/, '');
  const items = [...(inv.installs || []).map(i => ({ ...productOf(i.tool, i.version), tool: i.tool })).filter(x => x.product),
    ...(inv.os ? [{ product: 'macos', version: inv.os, tool: 'macOS' }] : [])];
  const cache = new Map(), hits = [], bad = [];
  for (const it of items) {
    if (!cache.has(it.product)) cache.set(it.product, json(await get(ctx, `${base}/${it.product}.json`, s)));
    const cycles = cache.get(it.product);
    if (!Array.isArray(cycles)) { bad.push(it.product); continue; }
    const c = cycleOf(cycles, it.version);
    if (!c) continue;
    const ended = c.eol === true || (typeof c.eol === 'string' && c.eol <= ctx.today);
    if (!ended) continue;
    const supported = cycles.filter(x => x.eol === false || (typeof x.eol === 'string' && x.eol > ctx.today)).map(x => String(x.cycle));
    hits.push({
      pkg: { ecosystem: 'eol', name: it.product, version: it.version, tool: it.tool, top: true },
      record: { id: `EOL-${it.product}-${c.cycle}`, aliases: [], summary: `${it.product} ${c.cycle} reached its end of life${typeof c.eol === 'string' ? ` on ${c.eol}` : ''}: no more security fixes`,
        _severity: s.eol_severity, _fixed: '', _url: `https://endoflife.date/${it.product}`, _supported: supported.slice(0, 3) },
    });
  }
  return { hits, error: bad.length ? `endoflife.date had no answer for ${bad.join(', ')}` : '' };
}

module.exports = { epss, eol, PRODUCTS, productOf, cycleOf };
