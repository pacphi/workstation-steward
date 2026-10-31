#!/usr/bin/env node
// What Claude Code would get from the steward plugin's session-start hook, from this checkout, before a release has it
// (`just try-hook`, docs/maintainers.md). For each way a session starts (startup, clear, compact, resume) it prints the
// JSON `steward brief --hook` returns, what the user would see (systemMessage), what Claude would be told
// (additionalContext) and how long it took. Read-only: DRY_RUN=1, so no stamp is written, and STEWARD_NO_REFRESH=1,
// so no background refresh starts. `steward` is this checkout's bin/steward.js, a dev build: it uses examples/ and
// its own state unless given --real (your config and your state, read only).
// Usage: try-hook.js [--real]
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const real = process.argv.includes('--real');
const env = { ...process.env, STEWARD_CHANNEL: 'dev', DRY_RUN: '1', STEWARD_NO_REFRESH: '1' };
const stewardArgs = [path.join(ROOT, 'bin', 'steward.js'), 'brief', '--hook', ...(real ? ['--real'] : [])];

const where = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'steward.js'), 'config', '--json', ...(real ? ['--real'] : [])], { encoding: 'utf8', env });
let state = null;
try { state = JSON.parse(where.stdout).paths.state; } catch { /* shown as unknown */ }
const stamp = state && path.join(state, 'brief', 'shown.json');
console.log(`instance: ${real ? 'your config (--real)' : 'examples/ (add --real for your config)'}; read-only (DRY_RUN=1, STEWARD_NO_REFRESH=1)`);
const now = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'steward.js'), 'brief', ...(real ? ['--real'] : [])], { encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
console.log(`brief:    ${now.stdout.trim().split('\n').join('\n          ')}`);
console.log(`stamp:    ${stamp ? `${stamp}${fs.existsSync(stamp) ? `: ${fs.readFileSync(stamp, 'utf8').trim()}` : ' (none yet: a startup shows the briefing)'}` : 'unknown'}`);

for (const source of ['startup', 'clear', 'compact', 'resume']) {
  const input = JSON.stringify({ session_id: 'try-hook', cwd: process.cwd(), hook_event_name: 'SessionStart', source });
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, stewardArgs, { encoding: 'utf8', env, input });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`\n== ${source}: exit ${r.status}, ${ms.toFixed(0)} ms, ${r.stdout ? `${r.stdout.length} bytes` : 'nothing printed (nothing needs you, or the hook stays quiet here)'}`);
  if (r.stderr.trim()) console.log(`stderr (Claude Code doesn't show it): ${r.stderr.trim()}`);
  if (!r.stdout) continue;
  console.log(`raw: ${r.stdout.trim()}`);
  let out;
  try { out = JSON.parse(r.stdout); } catch (e) { console.log(`NOT JSON: ${e.message}`); continue; }
  if (out.systemMessage) console.log(`-- the user sees:\n${out.systemMessage}`);
  const ctx = out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
  if (ctx) console.log(`-- Claude is told (${ctx.length} characters; Claude Code's cap is 10,000):\n${ctx}`);
}
