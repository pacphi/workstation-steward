// The platform the steward runs on, by the names host.toml and the audit's checks use (R5c): macos, linux, windows.
// A host.toml entry that holds for one platform only says so with `platforms = ["macos"]`; an entry without the key
// holds on every platform, which is what every entry meant before the key existed.
const NAMES = { darwin: 'macos', linux: 'linux', win32: 'windows' };
const PLATFORMS = ['macos', 'linux', 'windows'];

// current(nodePlatform) — this machine's platform name
const current = (p = process.platform) => NAMES[p] || p;

// applies(entry, platform) — whether a host.toml entry holds here: a plain value, or a table without `platforms`, always
const applies = (e, platform = current()) => !e || typeof e !== 'object' || !Array.isArray(e.platforms) || e.platforms.includes(platform);

module.exports = { PLATFORMS, current, applies };
