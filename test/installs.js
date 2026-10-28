// missing(tools) — what the onboarding and offboarding tests need from the AI tool installs (the Ruflo CLI's .claude
// folders, the shared AQE runtime) that isn't there under the current config, or false. test/fixtures.js asks it whether
// to use the real installs or its stand-ins, and again to check the stand-ins are complete.
const fs = require('fs');
const os = require('os');
const F = require('../lib/profiles.js');

function missing(tools) {
  const ph = F.placeholders(os.tmpdir());
  const need = [ph.AQE];
  try {
    for (const c of F.render(tools, os.tmpdir()).copies) need.push(c.from);
  } catch (e) {
    return `needs the qualified AI tool installs (${e.message.split('\n')[0]})`;
  }
  const absent = [...new Set(need)].filter(p => p && !fs.existsSync(p));
  return absent.length ? `needs the qualified AI tool installs; missing ${absent.slice(0, 2).join(', ')}${absent.length > 2 ? ` and ${absent.length - 2} more` : ''}` : false;
}

module.exports = { missing };
