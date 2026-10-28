# Rust (Cargo)

Evidence: ampel#86, #90; a private Rust + Svelte app; emailibrium#308, #312, #313; finima#170; a private Rust CLI;
audioshake-cli#15; the ctutils PRs (audioshake-cli#19, a private Rust CLI, emailibrium#312).

## CI gates to find

- `cargo fmt --all --check`, the clippy line verbatim (ampel: `-D warnings -D clippy::all`),
  `cargo test`/`nextest`, `--locked` builds, benches/doctests jobs.
- Audit: `cargo audit`, `cargo deny check ...`, `rustsec/audit-check`, or a repo script
  (`.github/scripts/cargo-audit.sh` reading `audit-ignore` in emailibrium and finima).
- The toolchain pin: `rust-toolchain.toml`, `RUST_VERSION` env in workflows, `dtolnay/rust-toolchain@<ver>`.
- Feature flags CI builds. emailibrium's `builtin-llm` feature isn't built in CI, so green CI says
  nothing about it (emailibrium#308).

## Audit

```bash
cargo audit                                     # RustSec; scans the raw Cargo.lock
cargo deny check advisories bans licenses sources   # if deny.toml exists or CI runs it
bash .github/scripts/cargo-audit.sh --no-fetch   # when CI uses a repo script: run THAT
```

- **RustSec runs ahead of the GitHub Advisory DB.** rustls-webpki (RUSTSEC-2026-0382),
  webpki-roots (-0381) and webpki-root-certs (-0383) were in RustSec while GitHub showed no
  alerts for them, so no bot PR existed (ampel#86, triage notes-C; AGENTS.md).
  `cargo audit` is the source of truth for Rust; still check GHSA and OSV for the exception rule.
- **The reverse happens too:** rmcp had four GHSAs and no RustSec entry for 1.7.0, so cargo-audit
  stayed green (emailibrium#308). Report GHSA-only findings even when CI is green.
- **`cargo deny` fails on things `cargo audit` only warns about:** unsound advisories (tokio
  RUSTSEC-2026-0386, event-listener RUSTSEC-2026-0221) and yanked crates when `yanked = "deny"`
  (chacha20 0.10.1) (a private Rust + Svelte app). An earlier `cargo audit` failure in the same job hides it
  (ampel#86).
- `cargo audit` reads the whole lockfile, including crates that are never compiled (a Rust + Svelte app's
  quinn-proto). Bump them anyway; the gate doesn't care.
- **Mirror the ignore file CI reads.** emailibrium and finima keep `audit-ignore` (read by the CI
  script) and `.cargo/audit.toml` (local); add an ignore to both (emailibrium#308, finima#170).
  Stale ignores whose crate left the lockfile are worth reporting (emailibrium#308).
- Unmaintained-only advisories with no patch get an ignore with an exit condition:
  unsafe-libyaml RUSTSEC-2024-0449 via `serde_yaml` (ampel#86, emailibrium#308, finima#170).
  If the dependency is unused, remove it instead (audioshake-cli#15 dropped `serde_yaml`).
- Ignores need reachability: zip RUSTSEC-2026-0367/-0368/-0369 affect `extract()`, which neither
  calamine nor candle calls (finima#170, a private Rust CLI).
- Use `cargo tree -i <crate>@<ver>` to find what pulls an old copy. audioshake-cli's 7 findings
  came from aws-sdk-s3's default `rustls` feature pulling hyper 0.14 / rustls 0.21; setting
  `default-features = false` and keeping the needed features removed them (audioshake-cli#15).

## Bumping a transitive-only crate

```bash
cargo update -p <crate>@<current> --precise <version>   # lockfile only
```

If the `Cargo.toml` requirement already allows the version, only `Cargo.lock` changes, which is
correct (ampel#90, emailibrium#312). `scripts/lock-fix.sh` does this as a one-advisory PR, with the
release-age check and the repo's audit command.

## Publish dates

```bash
curl -s -A '<contact>' https://crates.io/api/v1/crates/<crate>/<version> | jq -r .version.created_at
```

crates.io wants a User-Agent and at most one request per second (`lock-age.sh` does both). To
resolve a whole lockfile as of a date, audioshake-cli#15 used
`cargo +nightly -Zunstable-options generate-lockfile --publish-time 2026-10-19T16:00:00Z`, then
checked all 384 crates by `created_at`.

## Known traps

- **First patched release only.** ctutils 0.4.4 (2026-10-23T01:04Z) was the first patched
  release for RUSTSEC-2026-0385; 0.4.5 came three hours later and was not taken (a private Rust + Svelte app,
  emailibrium#312).
- **Yanked versions.** tokio 1.54.0 was yanked and 1.54.1 was under 3 days old, so repos stayed
  on 1.53.3 (a private Rust + Svelte app, a private Rust CLI, emailibrium#312).
- **Git submodules as Cargo path dependencies.** emailibrium's backend depends on
  `../ruvector/crates/...`, a git submodule; clone with `--recurse-submodules` or Cargo can't
  resolve.
- **A one-crate fix PR can't pass if the base has other advisories.** The ctutils fix failed its
  audit on emailibrium `main` (15 other vulnerabilities) and a Rust + Svelte app's `main` (12); emailibrium needed
  the full backport (#313) instead.
- **`Cargo.lock` gitignored** means CI resolves fresh every run, so new crate releases can raise
  the MSRV under you (aws-* needed rustc 1.94.1 while CI pinned 1.92.0). audioshake-cli#15
  committed the lockfile and moved CI to 1.99.1.
- **`rustsec/audit-check` installs `cargo-audit` without `--locked`**, so the tool itself stopped
  building on the repo's pinned rustc. A private Rust CLI pre-installed `cargo-audit@0.22.2` with a
  SHA-pinned `taiki-e/install-action` first; audit-check uses the binary on PATH.
- **0.x crates:** a minor is a major. candle 0.10 → 0.11 was blocked anyway because mistralrs
  hard-requires `candle-core ^0.10.2` (finima#170); zip 8 → 9 was a one-line port that would drop
  three ignores (a private Rust CLI), deferred for the owner.
- **Platform-dependent tests** surface as pre-existing failures: a nanosecond `now_utc()` compared
  with Postgres microsecond `timestamptz` failed on Linux only (a private Rust + Svelte app).
