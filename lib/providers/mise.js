// mise as a provider (R5c): the toolchain on every platform. Its own minimum_release_age applies the release-age gate,
// and its lock and the steward's backups let a version go back. Every command goes through ctx.run.
const id = 'mise';
const platforms = ['macos', 'linux', 'windows'];
const canRollback = true;

const available = async ctx => (await ctx.run('mise', ['--version'])).status === 0;

// outdated(ctx) — [{name, have, want}] from `mise outdated --bump --json`: a tool requested as "latest" moves to its
// latest, a pinned one to its bump (the same precision). mise holds both to minimum_release_age: on 2026-10-28 it
// offered gh 2.103.2 (4 days old) and held 2.103.3 (1 day), and flyctl 0.4.122 over 0.4.123 likewise.
async function outdated(ctx) {
  const r = (await ctx.run('mise', ['outdated', '--bump', '--json']));
  if (r.status !== 0) throw new Error('mise outdated failed');
  return Object.entries(JSON.parse(r.stdout || '{}'))
    .map(([name, t]) => ({ name, have: t.current, want: t.requested === 'latest' ? t.latest : (t.bump || t.latest) }))
    .filter(t => t.want && t.want !== t.have);
}

module.exports = { id, platforms, canRollback, available, outdated };
