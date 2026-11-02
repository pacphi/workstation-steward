// Distrusted roots on Linux (parity 0.5, supply-chain/checks/index.js `trust`): the family's system CA bundle,
// Linuxbrew's ca-certificates and Node's bundled roots, as on macOS the keychain, Homebrew's bundle and Node's roots. A
// root still trusted is an action; a bundle that can't be found is a note, never a quiet "not in". Bundles here are built
// from one of Node's own root certificates, so no network and no openssl. `just linux-test` reads each image's real one.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const K = require('../supply-chain/checks/index.js');
const { audit } = require('../supply-chain/bin/audit.js');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'steward-trust-')));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const lines = () => { const out = []; return { out, write: s => out.push(s.replace(/\x1b\[[0-9;]*m/g, '')) }; };
const PEM = tls.rootCertificates[0];
const SHA = new X509Certificate(PEM).fingerprint256.replace(/:/g, '');

// sysroot(name, file) — a fake / with one system bundle holding PEM at file (or none)
function sysroot(name, file) {
  const r = path.join(ROOT, name);
  fs.mkdirSync(r, { recursive: true });
  if (file) put(path.join(r, file), `${PEM}\n`);
  return r;
}
const ctx = (extra = {}) => ({
  run: async () => ({ status: 1, stdout: '' }), now: new Date('2026-11-02T12:00:00Z'), today: '2026-11-02', home: path.join(ROOT, 'home'), instance: ROOT,
  engine: path.join(__dirname, '..'), cache: path.join(ROOT, 'cache'), cfg: { policy: { min_release_age_days: 3 }, paths: { mise_data_dir: path.join(ROOT, 'mise') } },
  appDirs: [], platform: 'linux', ...extra,
});
const roots = [{ name: 'Still trusted', _source: 'default', sha256: SHA }, { name: 'Gone already', _source: 'yours', sha256: 'AB'.repeat(32) }];

test('systemBundle: the family\'s system CA bundle; an unknown family takes the first known one there; none is null', () => {
  const deb = sysroot('deb', 'etc/ssl/certs/ca-certificates.crt');
  const rhel = sysroot('rhel', 'etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem');
  const suse = sysroot('suse', 'var/lib/ca-certificates/ca-bundle.pem');
  assert.equal(K.systemBundle(ctx({ family: 'debian', sysroot: deb })), path.join(deb, 'etc/ssl/certs/ca-certificates.crt'));
  assert.equal(K.systemBundle(ctx({ family: 'rhel', sysroot: rhel })), path.join(rhel, 'etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem'));
  assert.equal(K.systemBundle(ctx({ family: 'suse', sysroot: suse })), path.join(suse, 'var/lib/ca-certificates/ca-bundle.pem'));
  assert.equal(K.systemBundle(ctx({ family: 'arch', sysroot: deb })), path.join(deb, 'etc/ssl/certs/ca-certificates.crt'), 'Arch uses Debian\'s path');
  assert.equal(K.systemBundle(ctx({ family: null, sysroot: suse })), path.join(suse, 'var/lib/ca-certificates/ca-bundle.pem'));
  assert.equal(K.systemBundle(ctx({ family: 'debian', sysroot: sysroot('bare') })), null);
});

test('trust on Linux: a distrusted root in the system bundle is an action; one not there is ok; Node\'s roots are checked too', async () => {
  const sys = sysroot('deb-audit', 'etc/ssl/certs/ca-certificates.crt');
  const bundle = path.join(sys, 'etc/ssl/certs/ca-certificates.crt');
  const w = lines();
  const r = await audit(ctx({ family: 'debian', sysroot: sys, policy: { distrusted_root: roots } }), { only: ['trust'], write: w.write });
  assert.deepEqual(r.skipped, [], 'trust runs on Linux');
  assert.ok(r.actions.includes(`trust: Still trusted is in the system bundle ${bundle}; distrust it by hand for now (parity 2.1 adds the family's own command)`), r.actions.join('\n'));
  assert.ok(r.actions.some(a => a.startsWith(`trust: Still trusted in Node ${process.version}'s bundled roots`)), 'Node\'s own roots, as on macOS');
  assert.ok(w.out.includes(`  ok     Gone already (yours): not in the system bundle ${bundle}`), w.out.join('\n'));
  assert.ok(!r.actions.some(a => a.includes('Gone already')));
});

test('trust on Linux with no system bundle found: a note naming where it looked, never "not in"', async () => {
  const w = lines();
  await audit(ctx({ family: 'debian', sysroot: sysroot('none'), policy: { distrusted_root: roots } }), { only: ['trust'], write: w.write });
  assert.ok(w.out.some(l => l.startsWith('  info   system CA bundle not found (looked in /etc/ssl/certs/ca-certificates.crt, ') && l.endsWith('); distrusted roots there were not checked')), w.out.join('\n'));
  assert.ok(!w.out.some(l => l.includes('not in the system bundle')));
});
