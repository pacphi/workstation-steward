#!/usr/bin/env node
// lock-check.js [mise.lock] — every platform entry's download URL must name its tool's locked version. Renovate's
// hosted bot (Linux) can bump a tool's `version` in mise.lock and leave some or all platforms' URLs and checksums on
// the previous release (2026-10-26: aws, flyctl, powershell, snyk, uv); mise then installs the old files under the
// new version's name. Fix a failure on the Mac: `mise lock --global <tool>…`. Exit 1 on any mismatch.
// Skipped: entries whose URLs name a build number rather than the version (the Android SDK).
const fs = require('fs');
const file = process.argv[2] || require('../../lib/config.js').instance('mise/mise.lock');
// With no file named, an instance without a lockfile (a new one, or the examples) has nothing to check
if (!process.argv[2] && !fs.existsSync(file)) { console.log('mise.lock: none in the instance, nothing to check'); process.exit(0); }
let tool = null, version = null, plat = null;
const bad = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  let m;
  if ((m = line.match(/^\[\[tools\.("?[^\]"]+"?)\]\]/))) { tool = m[1]; version = null; plat = null; }
  else if ((m = line.match(/^\[tools\.("?[^\]"]+"?)\."platforms\.([^"]+)"\]/))) plat = m[2];
  else if ((m = line.match(/^version = "([^"]+)"/)) && !plat) version = m[1];
  else if ((m = line.match(/^url = "([^"]+)"/)) && plat && version && !/android-sdk/.test(tool)) {
    const v = version.replace(/^v/, '').replace(/^[a-z]+-/, ''); // liberica-25.0.4.1+1 → 25.0.4.1+1
    if (!decodeURIComponent(m[1]).includes(v)) bad.push(`${tool} ${version} ${plat}: ${m[1]}`);
  }
}
for (const b of bad) console.log(`  STALE ${b}`);
console.log(bad.length ? `${bad.length} platform URL(s) don't name their locked version: run \`mise lock --global <tool>\` on the Mac` : 'mise.lock: every platform URL names its locked version');
process.exitCode = bad.length ? 1 : 0;
