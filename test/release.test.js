// What cuts a release (D47): release-please skips a commit whose files all sit under its exclude-paths, so those
// folders must hold nothing a user gets. That is the npm package (package.json `files`, plus what npm always packs),
// and the Renovate preset, which config repos extend at a release tag. No network. Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = f => JSON.parse(fs.readFileSync(path.join(REPO, f), 'utf8'));
const trim = p => p.replace(/^\/+|\/+$/g, '');
// npm packs these whatever `files` says; renovate/ is read from the tag
const ALWAYS = ['package.json', 'README.md', 'LICENSE', 'renovate'];

test('release: exclude-paths are folders that hold nothing users get', () => {
  const excluded = read('release-please-config.json').packages['.']['exclude-paths'].map(trim);
  const shipped = [...read('package.json').files, ...ALWAYS].map(trim);
  assert.ok(excluded.length > 0);
  for (const ex of excluded) {
    // release-please matches folders only (`file` starts with `path/`), so a top-level file listed here does nothing
    assert.ok(fs.statSync(path.join(REPO, ex)).isDirectory(), `${ex}: exclude-paths can only skip folders`);
    for (const s of shipped) {
      assert.ok(s !== ex && !s.startsWith(`${ex}/`) && !ex.startsWith(`${s}/`), `${ex} overlaps ${s}, which users get`);
    }
  }
});
