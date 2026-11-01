// lib/platform.js (parity 0.1, D63): the platform, and on Linux the distribution, its version and its family, read
// from os-release (/etc/os-release, else /usr/lib/os-release). The family is what providers, trust stores and
// host.toml's `families` key go by. macOS and Windows have none. No network, no real os-release read.
// Run: just test
const test = require('node:test');
const assert = require('node:assert/strict');
const PL = require('../lib/platform.js');

// Sample os-release files, one per row of docs/platforms/parity.md, plus two that only ID_LIKE can place. The
// versions are sample data for the parser, not the supported releases (those are checked in each provider PR).
const SAMPLES = {
  debian: ['PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nID=debian\n', 'debian', '13', 'debian'],
  ubuntu: ['PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n', 'ubuntu', '24.04', 'debian'],
  mint: ['NAME="Linux Mint"\nVERSION_ID="22.2"\nID=linuxmint\nID_LIKE="ubuntu debian"\n', 'linuxmint', '22.2', 'debian'],
  fedora: ['NAME="Fedora Linux"\nVERSION_ID=43\nID=fedora\n', 'fedora', '43', 'rhel'],
  leap: ['NAME="openSUSE Leap"\nVERSION_ID="16.0"\nID="opensuse-leap"\nID_LIKE="suse opensuse"\n', 'opensuse-leap', '16.0', 'suse'],
  tumbleweed: ['NAME="openSUSE Tumbleweed"\nVERSION_ID="20261030"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n', 'opensuse-tumbleweed', '20261030', 'suse'],
  arch: ['NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n', 'arch', null, 'arch'],
  alpine: ['NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.22.2\n', 'alpine', '3.22.2', 'alpine'],
  void: ['NAME="Void"\nID="void"\nPRETTY_NAME="Void Linux"\n', 'void', null, 'void'],
  gentoo: ['NAME=Gentoo\nID=gentoo\nVERSION_ID=2.18\n', 'gentoo', '2.18', 'gentoo'],
  slackware: ['NAME=Slackware\nVERSION="15.0"\nID=slackware\nVERSION_ID=15.0\n', 'slackware', '15.0', 'slackware'],
  nixos: ['NAME=NixOS\nID=nixos\nVERSION_ID="25.05"\nPRETTY_NAME="NixOS 25.05 (Warbler)"\n', 'nixos', '25.05', 'nixos'],
  rocky: ['NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="10.0"\n', 'rocky', '10.0', 'rhel'],
  pop: ['NAME="Pop!_OS"\nID=pop\nID_LIKE="ubuntu debian"\nVERSION_ID="24.04"\n', 'pop', '24.04', 'debian'],
};

test('FAMILIES: the nine Linux families, in a fixed order', () => {
  assert.deepEqual(PL.FAMILIES, ['debian', 'rhel', 'suse', 'arch', 'alpine', 'void', 'gentoo', 'slackware', 'nixos']);
});

test('parseOsRelease and familyOf: every sample lands in its family, by ID first and then ID_LIKE', () => {
  for (const [name, [text, id, version, family]] of Object.entries(SAMPLES)) {
    const r = PL.parseOsRelease(text);
    assert.equal(r.id, id, `${name}: id`);
    assert.equal(r.version, version, `${name}: version`);
    assert.equal(PL.familyOf(r.id, r.like), family, `${name}: family`);
  }
  assert.deepEqual(PL.parseOsRelease(SAMPLES.mint[0]).like, ['ubuntu', 'debian']);
});

test('parseOsRelease: quotes, comments, escapes, blank lines and junk follow the os-release format', () => {
  const r = PL.parseOsRelease('# a comment\n\nID=\'weird\'\nPRETTY_NAME="A \\"quoted\\" \\$name"\nnot a line\nID_LIKE=""\n');
  assert.equal(r.id, 'weird');
  assert.equal(r.pretty, 'A "quoted" $name');
  assert.deepEqual(r.like, []);
  assert.equal(r.version, null);
  const empty = PL.parseOsRelease('');
  assert.deepEqual(empty, { id: null, like: [], version: null, pretty: null });
  assert.equal(PL.familyOf('nobody', ['nothing']), null, 'an unknown distribution has no family');
  assert.equal(PL.familyOf(null, []), null);
});

test('describe: Linux reads /etc/os-release, else /usr/lib/os-release; neither gives an unknown distribution', () => {
  const reader = files => f => { if (f in files) return files[f]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const etc = PL.describe({ nodePlatform: 'linux', read: reader({ '/etc/os-release': SAMPLES.ubuntu[0], '/usr/lib/os-release': SAMPLES.arch[0] }) });
  assert.deepEqual(etc, { platform: 'linux', distro: 'ubuntu', version: '24.04', family: 'debian', pretty: 'Ubuntu 24.04.3 LTS' });
  const lib = PL.describe({ nodePlatform: 'linux', read: reader({ '/usr/lib/os-release': SAMPLES.nixos[0] }) });
  assert.equal(lib.distro, 'nixos');
  assert.equal(lib.family, 'nixos');
  const none = PL.describe({ nodePlatform: 'linux', read: reader({}) });
  assert.deepEqual(none, { platform: 'linux', distro: null, version: null, family: null, pretty: null });
});

test('describe: macOS and Windows have no distribution or family, and read no file', () => {
  const read = () => { throw new Error('read on a platform without os-release'); };
  assert.deepEqual(PL.describe({ nodePlatform: 'darwin', read }), { platform: 'macos', distro: null, version: null, family: null, pretty: null });
  assert.deepEqual(PL.describe({ nodePlatform: 'win32', read }), { platform: 'windows', distro: null, version: null, family: null, pretty: null });
  assert.equal(PL.current('darwin'), 'macos', 'current() is unchanged');
});

test('label: macOS is unchanged; Linux names its distribution and version', () => {
  assert.equal(PL.label({ platform: 'macos', distro: null, version: null, family: null }), 'macos');
  assert.equal(PL.label({ platform: 'linux', distro: 'ubuntu', version: '24.04', family: 'debian' }), 'linux (ubuntu 24.04)');
  assert.equal(PL.label({ platform: 'linux', distro: 'arch', version: null, family: 'arch' }), 'linux (arch)');
  assert.equal(PL.label({ platform: 'linux', distro: null, version: null, family: null }), 'linux (unknown distribution)');
});

test('applies: families narrows the Linux part only; without families nothing changes', () => {
  const nix = { name: 'x', platforms: ['linux'], families: ['nixos'] };
  assert.equal(PL.applies(nix, 'linux', 'nixos'), true);
  assert.equal(PL.applies(nix, 'linux', 'debian'), false);
  assert.equal(PL.applies(nix, 'linux', null), false, 'an unknown family is not listed');
  assert.equal(PL.applies(nix, 'macos', null), false);
  const both = { name: 'y', platforms: ['macos', 'linux'], families: ['nixos'] };
  assert.equal(PL.applies(both, 'macos', null), true, 'the macOS part is not narrowed');
  assert.equal(PL.applies(both, 'linux', 'arch'), false);
  const bare = { name: 'z', families: ['debian'] };
  assert.equal(PL.applies(bare, 'linux', 'debian'), true, 'families without platforms is treated as Linux only');
  assert.equal(PL.applies(bare, 'macos', null), false);
  assert.equal(PL.applies({ name: 'p', platforms: ['linux'] }, 'linux', 'rhel'), true);
  assert.equal(PL.applies('plain', 'linux', 'rhel'), true);
});
