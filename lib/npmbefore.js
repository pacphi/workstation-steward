#!/usr/bin/env node
// npm's --before for an npm -g hybrid install (D89): every dependency npm resolves must be at least the release-age gate's
// days old, as the hybrid itself is. Without it, a pinned, gated hybrid still pulls sub-dependencies published hours ago
// (2026-11-16: ruflo@3.77.0 would have taken six under 3 days old).
//   - the cutoff is now minus [policy] min_release_age_days
//   - when the pinned version itself is newer than that (a security exception), the cutoff moves to just after its own
//     publish time, so npm can still find it; its dependencies are then those of that moment, never newer
//   - npm view's time answer is an object, or (npm 12) a one-element array holding it; both are read
// Usage: npmbefore.js <days> [<name> <version>]   prints the ISO cutoff. DRY_RUN=1: npm isn't asked.
const { execFileSync } = require('child_process');

// times(text) — {version: ISO} from `npm view <name> time --json`, an object or an array of them; {} when unreadable
function times(text) {
  try {
    const j = JSON.parse(text);
    const t = Array.isArray(j) ? Object.assign({}, ...j.filter(x => x && typeof x === 'object')) : j;
    return t && typeof t === 'object' ? t : {};
  } catch { return {}; }
}

// before(days, published, now) — the ISO cutoff: now minus days, or one second after published when that is later
function before(days, published, now = new Date()) {
  let t = now.getTime() - Number(days) * 864e5;
  const p = Date.parse(published || '');
  if (Number.isFinite(p) && p + 1000 > t) t = p + 1000;
  return new Date(t).toISOString();
}

module.exports = { times, before };

if (require.main === module) {
  const [days, name, version] = process.argv.slice(2);
  if (!/^\d+$/.test(days || '')) { console.error('usage: npmbefore.js <days> [<name> <version>]'); process.exit(2); }
  let published = '';
  if (name && version && process.env.DRY_RUN !== '1') {
    try {
      published = times(execFileSync('npm', ['view', name, 'time', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }))[version] || '';
    } catch { /* unreadable: the plain cutoff, and npm says so if the pin is newer */ }
  }
  console.log(before(days, published));
}
