// Hook timeouts written in milliseconds. Claude Code's hook `timeout` is in SECONDS (default 600), so Ruflo's 5000 means
// 83 minutes and its 60000 means 16 hours: the hook is effectively never cut off. Nothing here writes; ai-tooling/bin/
// timeouts.js does, after a plan and a yes, and ai drift reports.
// A value of 1000 or more is a millisecond value: no hook should run for 16 minutes, and the seconds values in use top out at 60.

const MS_FLOOR = 1000;

// find(settings) — [{path: 'hooks.Stop.1.hooks.0', value}] for every hook timeout that is a millisecond value
function find(settings) {
  const out = [];
  (function walk(o, p) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.timeout === 'number' && o.timeout >= MS_FLOOR) out.push({ path: p.join('.'), value: o.timeout });
    for (const k of Object.keys(o)) walk(o[k], p.concat(k));
  })(settings && settings.hooks, ['hooks']);
  return out;
}

// fixed(settings) — a copy with each millisecond timeout turned into whole seconds, rounded up (5000 → 5, 6000 → 6)
function fixed(settings) {
  const next = JSON.parse(JSON.stringify(settings));
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.timeout === 'number' && o.timeout >= MS_FLOOR) o.timeout = Math.ceil(o.timeout / 1000);
    for (const k of Object.keys(o)) walk(o[k]);
  })(next.hooks);
  return next;
}

// serialize(text, settings) — settings as JSON in the file's own indent and final newline, or null when the file would not
// round-trip unchanged (then a rewrite would reformat more than the timeouts, so the caller skips it)
function serialize(text, settings, original) {
  const indent = (text.split('\n').find((l, i) => i > 0 && /^\s+\S/.test(l)) || '').match(/^\s*/)[0] || '  ';
  const end = text.endsWith('\n') ? '\n' : '';
  if (JSON.stringify(original, null, indent) + end !== text) return null;
  return JSON.stringify(settings, null, indent) + end;
}

// the settings files to look at in one folder
const FILES = ['.claude/settings.json', '.claude/settings.local.json'];

module.exports = { find, fixed, serialize, FILES, MS_FLOOR };
