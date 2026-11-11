# Linux and NixOS parity

![Revision 20](https://img.shields.io/badge/Revision-20-green) ![Revised 2026-11-11](https://img.shields.io/badge/Revised-2026--11--11-green)

The plan and the progress ledger for bringing the steward from macOS to Linux distributions and NixOS. Every PR in
this work ticks its boxes here and links itself, so this page always says what is done, what is under way and what
is left.

- [Why this matters](#why-this-matters)
- [Where we are](#where-we-are)
- [How to use this ledger](#how-to-use-this-ledger)
- [Decisions](#decisions)
- [The Linux release: the bar](#the-linux-release-the-bar)
- [Supported platforms and minimum versions](#supported-platforms-and-minimum-versions)
- [What parity means: the capabilities](#what-parity-means-the-capabilities)
- [Milestone 0: a portable engine](#milestone-0-a-portable-engine)
- [Milestone 1: Linux, one package manager at a time](#milestone-1-linux-one-package-manager-at-a-time)
- [Milestone 2: Linux apps and trust stores](#milestone-2-linux-apps-and-trust-stores)
- [Milestone 3: NixOS](#milestone-3-nixos)
- [Testing: the CI matrix and install checks](#testing-the-ci-matrix-and-install-checks)
- [Facts to verify](#facts-to-verify)
- [Changes to this ledger](#changes-to-this-ledger)

## Why this matters

**Situation.** The steward runs on macOS only. The npm package says `"os": ["darwin"]`, and the Tests, Install check
and publish jobs run on macOS runners. R5c (D43 in [`../architecture.md`](../architecture.md#decisions)) laid the
groundwork: the audit is a list of checks that each name their platforms, package managers are providers, and
`host.toml` entries can say `platforms = [...]`.

**Opportunity.** Much of the engine already works anywhere: mise (pins, the release-age gate, upgrade, prune, soak,
rollback), the npm hybrids, advisory exceptions, Docker, the fleet, projects and most of AI tooling. Parity means
porting each **capability**, not each distribution.

**Impact.** A Linux machine or a NixOS host gets the Mac's promise: updates that wait out the release-age gate, show
a plan, ask first, back up, write a receipt and can be undone. An install check and a CI matrix prove it on every
combination we claim.

## Where we are

| Milestone | What it delivers | Stage | Done |
| --- | --- | --- | --- |
| [0. Portable engine](#milestone-0-a-portable-engine) | The engine runs on Linux with Linuxbrew and mise; the Mac's output is unchanged | Done | 9 / 9 |
| [1. Linux providers](#milestone-1-linux-one-package-manager-at-a-time) | System packages per package manager, gated and reversible | Under way | 1 / 10 |
| [2. Linux apps and trust](#milestone-2-linux-apps-and-trust-stores) | Flatpak, Snap, AppImage and the Electron window; trust store per family | Not started | 0 / 6 |
| [3. NixOS](#milestone-3-nixos) | The flake or channel as a whole, with generations as the way back | Not started | 0 / 6 |
| [Testing](#testing-the-ci-matrix-and-install-checks) | A CI row and an install-check row for every combination we claim | Under way | 5 / 7 |
| [The Linux release](#the-linux-release-the-bar) | 0.11.0: Milestone 0, apt, dnf and zypper at full parity | Under way | 1 / 8 |
| [Decisions](#decisions) | The choices the work depends on | All made | 12 / 12 |

## How to use this ledger

**Stages.** Every item passes through five stages, each approved by the owner before the next one starts:

1. **Architect:** where it fits, what it changes, which decision it needs.
2. **Design:** the interface, the data, the output the user sees.
3. **Test first:** the tests, shown failing on the old code.
4. **Implement:** the code, until the tests and gates pass.
5. **Document:** the docs, a D-row when behavior changes, and this ledger.

**Status marks** in the tables: ⬜ not started · 🟨 under way · ✅ done · ➖ doesn't apply · ⛔ blocked (say why).

**After each PR:**

- tick the boxes it finished and add the PR number beside each one, as `(#123)`;
- update the item's stage and the counts in [Where we are](#where-we-are);
- move a fact from [Facts to verify](#facts-to-verify) to its section once it is checked, with the source;
- add a line to [Changes to this ledger](#changes-to-this-ledger), and bump the revision badges here and in
  [`../README.md`](../README.md).

A box is ticked only when its check ran and passed. Something left undone stays open, with a note saying why.

## Decisions

**Made**

- [x] **Gate Linux system packages on the date a version entered the distro's repo** (owner, 2026-10-31). A version
  waits at least `min_release_age_days` (default 3) after it reached the repo. The first patched release for an
  advisory may skip the wait, as on macOS. A package manager with no reliable date source holds updates for review
  by hand rather than taking them.
- [x] **Every combination we claim gets an install check and a CI row** (owner, 2026-10-31).

- [x] **D-a. Two gate modes** (owner, 2026-10-31). *Per package* for apt, dnf, zypper and apk: each package waits
  until it has been in the repo at least the gate's days. *Dated snapshot* for pacman, xbps, portage and Nix: the whole
  system moves to a repo snapshot at least the gate's days old, because these managers don't support taking one package
  and holding another. The snapshot code is built once for Arch and reused for NixOS.
- [x] **D-b. Root steps: sudo at your terminal, else handed to you** (owner, 2026-10-31; revised 2026-11-03). The
  steward plans, and records what is installed, as you. At a terminal, after the plan's yes, it runs the one exact
  `sudo` command as a child on your terminal: you type your password into sudo's own prompt, and the steward never
  sees or keeps it. With no terminal (a pipe, an agent, `--unattended`) it hands you that command instead, keeps a
  waiting receipt, exits 4 ("waiting on you"), and `steward sc upgrade --resume` checks and finishes it; the briefing
  names a hand-off still waiting. Either way it then checks the result and writes the receipt. It never runs under
  `sudo`, so receipts and backups stay yours. (Before the revision, every root step was handed over.)
- [x] **D-c. Minimum versions: n-3, capped** (owner, 2026-10-31). Each distribution's newest release and the three
  before it, but never a release its vendor no longer gives security fixes. Ubuntu counts its LTS releases only.
  Rolling releases are current only. NixOS counts its stable channels, plus unstable.
- [x] **D-d. Six fully supported, three best effort** (owner, 2026-10-31). Full support means a CI row on every PR, an
  install-check row for each release, and bugs fixed before a release. It covers apt (Debian, Ubuntu, Linux Mint), dnf
  (Fedora), zypper (openSUSE), pacman (Arch), apk (Alpine, if its feasibility spike passes) and NixOS. Best effort
  means CI tests only, no install check, and fixes when someone reports them. It covers xbps (Void), portage (Gentoo)
  and slackpkg (Slackware).
- [x] **D-e. NixOS comes before Windows and WSL** (owner, 2026-10-31). It reuses the Linux work: the snapshot gate and
  the Linux checks. [`../lifecycle.md`](../lifecycle.md#platforms) has the new order.
- [x] **D-f. NixOS stays platform `linux`; `host.toml` gains an optional `families` key** (owner, 2026-10-31). An
  entry narrows itself with `families = ["nixos"]` or `["debian", "rhel"]`. The key is additive, like `platforms`
  (D43), so there is no format bump. A `linux` entry also holds on NixOS unless it is narrowed.
- [x] **D-g. mise on NixOS comes from nixpkgs, with `nix-ld`** (owner, 2026-10-31). `nix-ld` lets the prebuilt tools
  mise downloads run, so every mise capability works as it does elsewhere. Turning `nix-ld` on is a change to the
  host's config, made as a PR to the repo it lives in. The first NixOS PR checks the facts behind this first.
- [x] **R-1. No release until apt, dnf and zypper reach full parity** (owner, 2026-11-01); see
  [the bar](#the-linux-release-the-bar). They are built first, ahead of Flatpak, Snap, pacman and apk.
- [x] **R-2. Install checks before the release run in worktree mode from a commit** (owner, 2026-11-01); npm mode runs
  on every row right after the release, before it is announced.
- [x] **R-3. An urgent fix during the hold** goes to the owner's instance first, else out in a Mac-only release
  (owner, 2026-11-01).

## The Linux release: the bar

**No release of the steward until three Linux package managers reach full parity** (owner, 2026-11-01): **apt, dnf
and zypper**. That release is 0.11.0; after it, each further package manager ships in a release of its own. Until
then, release-please's release PR stays open and gathers every change; the owner merges it only when every box below is
ticked.

- [x] **Milestone 0 done** (0.1 to 0.9; #100).
- [ ] **apt, dnf and zypper done:** each provider's checklist in [Milestone 1](#milestone-1-linux-one-package-manager-at-a-time).
- [ ] **Their apps and trust items:** 2.1 for the Debian, Red Hat and SUSE families; 2.2 to 2.4 on their
  distributions.
- [ ] **CI green** on the oldest and newest supported release of Debian, Ubuntu, Linux Mint, Fedora, openSUSE Leap
  and Tumbleweed.
- [ ] **Install check, worktree mode,** from the release commit on every one of those rows (T.7):
  `gh workflow run install-check.yml -f ref=<release commit>`.
- [ ] **End-to-end runs** (`--e2e`) pass for apt, dnf and zypper.
- [ ] **Say it:** `package.json` `os` adds `linux`, the publish job moves to `ubuntu-latest`, and the README and [`../lifecycle.md`](../lifecycle.md#platforms)
  say the steward runs on Linux with apt, dnf and zypper.
- [ ] **Release,** then the install check in npm mode on every row before the release is announced. A failure there is
  fixed in 0.11.1.

**An urgent fix during the hold** (owner, 2026-11-01). New policy data (an IOC, a distrusted root, an exception) goes
into the owner's instance `host.toml` first, which needs no release. If code must ship, it goes out as a Mac-only
release from `main`: `package.json` `os` stays `darwin` and the README stays macOS until the bar above, so the Linux
code inside is dormant and unsupported. The Linux release is then 0.12.0.

## Supported platforms and minimum versions

The rule (D-c):

- each distribution's newest release and the three before it (**n-3**);
- never a release its vendor no longer gives security fixes, since the steward can't keep it current;
- Ubuntu counts its LTS releases only; rolling releases are current only; NixOS counts its stable channels, plus
  unstable;
- a release below the floor that Node 26's Linux binaries or mise need drops out, whatever the count says.

When a release leaves the rule, it drops in the steward's next minor release. `steward doctor` names a release that
isn't supported. Each provider PR checks the actual version numbers against the vendor's lifecycle page, cites it,
and writes them into this table.

**What counts as security support** (owner, 2026-11-03): the distribution's own free support from its own archive.
Debian LTS counts (it ships through `security.debian.org`); Ubuntu ESM and Debian ELTS don't, because they are paid
and need credentials. Linux Mint counts n-3 by series (21, 22), each on its Ubuntu LTS base; LMDE, Mint's Debian
edition, is on Mint's line too. The apt numbers, from distro-info-data's `debian.csv` and `ubuntu.csv` and
[Mint's release page](https://www.linuxmint.com/download_all.php), checked 2026-11-03:

| Release | Role | Free security support until |
| --- | --- | --- |
| Debian 12 | oldest | 2028-06-30 (LTS) |
| Debian 13 | newest | 2030-06-30 (LTS) |
| Ubuntu 22.04 | oldest | 2027-06-01 |
| Ubuntu 26.04 | newest | 2031-05-29 |
| Linux Mint 21.3 | oldest | April 2027 |
| Linux Mint 22.3 | newest | April 2029 |
| LMDE 7 | newest | not published: Mint's page says only "Long term support release (LTS)" |
| Fedora 44 | oldest | 2027-06-02 |
| Fedora 45 | newest | 2027-12-08 |

Ubuntu 24.04 and Mint 22 to 22.2 fall between oldest and newest, so they are inside the range. **Fedora** (dnf 1a,
checked 2026-11-11 on [Bodhi's releases API](https://bodhi.fedoraproject.org/releases/?exclude_archived=true), which
matches Fedora's [lifecycle page](https://docs.fedoraproject.org/en-US/releases/lifecycle/): release N is supported
until four weeks after N+2): Fedora 43, 44 and 45 are supported today, and Fedora 43 ends on 2026-12-02, three weeks
after Fedora 45's release on 2026-11-03, so D-c's cap leaves 44 and 45. os-release's `SUPPORT_END` is about two weeks
earlier than Bodhi's date (it is fixed when the release is built), so Bodhi is the source. Each row in
`test/containers/matrix.json` carries its end date and source; once a date passes, `just linux-test` and CI warn
"PAST SUPPORT: drop the row", and nothing goes red (owner, 2026-11-03).

**glibc** (measured 2026-11-03 in the oldest rows' images): Ubuntu 22.04 and Mint 21.3 have glibc 2.35, Debian 12
has 2.36; Fedora 44 has 2.43 and Fedora 45 2.44 (2026-11-11). Node 26.13.0's Linux build needs 2.28 and mise 2026.10.21 needs 2.18 (the newest `GLIBC_` symbol version
each binary asks for), so neither raises the floor.

| Distribution | Package manager | Kind | Minimum version | Support | Provider |
| --- | --- | --- | --- | --- | --- |
| Debian | apt | fixed releases | 12 (Debian LTS to 2028-06-30) to 13 | Full | 🟨 |
| Ubuntu | apt | fixed releases | 22.04 (standard support to 2027-06-01) to 26.04 | Full | 🟨 |
| Linux Mint | apt | fixed releases | 21.3 (to April 2027) to 22.3, by series; LMDE 7 | Full | 🟨 |
| Fedora | dnf | fixed releases | 44 (to 2027-06-02) to 45 | Full | 🟨 |
| openSUSE Leap | zypper | fixed releases | n-3, capped | Full | ⬜ |
| openSUSE Tumbleweed | zypper | rolling | current | Full | ⬜ |
| Arch Linux | pacman | rolling | current | Full | ⬜ |
| Alpine | apk | fixed releases (musl) | n-3, capped | Full, if the feasibility spike passes | ⬜ |
| Void | xbps | rolling | current | Best effort | ⬜ |
| Gentoo | portage | rolling, built from source | current | Best effort | ⬜ |
| Slackware | slackpkg | fixed releases | n-3, capped | Best effort | ⬜ |
| NixOS | nix | declarative | n-3 of the stable channels, capped, plus unstable | Full | ⬜ |
| Any of the above + Linuxbrew | brew (formulae only) | overlay | as its base | *D-d* | ⬜ |

## What parity means: the capabilities

Each row is something the steward does on a Mac today. The columns say how it gets to Linux and NixOS.

| Capability | macOS (built) | Linux | NixOS | Status |
| --- | --- | --- | --- | --- |
| mise toolchain, hybrids, gate, soak, prune, rollback | ✅ | works after Milestone 0; `node-patch` needs Linux tarballs | mise from nixpkgs, with `nix-ld` for the tools it downloads (D-g) | ⬜ |
| System packages | Homebrew | one provider per package manager; Linuxbrew reuses Homebrew's | one `nix` provider over the flake or channel | ⬜ |
| Release-age gate | Homebrew commit dates | the date a version reached the repo, or a dated snapshot (D-a) | a nixpkgs revision at least the gate's days old | ⬜ |
| Way back | mise yes, Homebrew no | per manager; where there is none, the plan says so | generations | ⬜ |
| OS updates | `softwareupdate -l` | part of the system provider: apt's is read-only, as on a Mac (D79) | moving nixpkgs is the OS update | 🟨 |
| Apps and the Electron window | `/Applications`, casks | Flatpak, Snap, AppImage, `/opt` | Nix apps; Flatpak where enabled | ⬜ |
| App store | `mas` | Flatpak and Snap stand in | ➖ | ⬜ |
| Trust store: finding distrusted roots | keychain, PEM bundles, Node's roots | the family's system bundle, Linuxbrew's and Node's roots (0.5) | the system bundle | 🟨 |
| Trust store: denying a root | admin trust setting (by hand) | per family: Debian, Red Hat, SUSE, Arch, Alpine | `security.pki` in the host's config, by a PR | ⬜ |
| Indicators of compromise | `ps`, Mac paths | procps or busybox `ps`, `/proc`, Linux paths | `/nix/store` paths | ⬜ |
| `steward doctor` install hints | Homebrew, mise | per family: apt, dnf, zypper (0.6) | per Nix setup | 🟨 |
| Fleet, projects, AI tooling | ✅ | already portable (git, gh, XDG paths), apart from the qualify scripts fixed in Milestone 0 | as Linux | ⬜ |

## Milestone 0: a portable engine

**Goal:** the steward runs on Linux with only the Homebrew and mise providers, and a Mac prints the same output as
before. **Done when:** `steward sc plan` and `steward sc audit` run clean on `ubuntu-latest` with Linuxbrew, and the
Mac's output before and after is identical.

Stage: Done (2026-11-02). Its exit criterion passes in CI on every PR (D74).

- [x] **0.1 Know the platform** (#84, D63). `lib/platform.js` reads `/etc/os-release` (`ID`, `ID_LIKE`, `VERSION_ID`) and returns
  the platform, distribution and family; NixOS by `ID=nixos`. `host.toml` entries take the optional `families` key
  (D-f), and `lib/host.js` checks it as it checks `platforms`. An entry with `families` must also say
  `platforms = ["linux"]`, and the steward warns when it doesn't (owner, 2026-11-01). Tests use sample os-release
  files for every row of the platforms table, and two that only `ID_LIKE` places.
- [x] **0.2 One contract for package sources** (#86, D64). Each package manager and kind is a source
  (`lib/providers/index.js`), and `judge()` makes the take-or-hold call for the audit and the plan alike. The plan loops
  over the sources that apply and are installed; a source that needs root was listed for the user and refused by
  `apply` until the apt provider brought the hand-off (owner, 2026-11-01; done in 1b, D76). mise keeps its own path. Proof: the Mac's host
  report, audit and plan were identical before and after (2026-11-01).
  - [ ] A tidy-up for later: the audit's held line says "eligible in N days" for a formula and not for a cask. Kept so
    the before-and-after proof stayed exact; make them match in a PR of its own.
- [x] **0.3 Bash that runs on GNU and busybox** (#88, D66). Five helpers in `lib/lib.sh` (`tmpfile`, `cp_clone`,
  `mv_onto`, `SHA256`/`SHA1`/`sha256_of`, `node_tarball`) replace 18 BSD-only sites, among them the `mktemp -t` blocker.
  Node replaces perl (`lib/timeout.js`, `lib/subst.js`; owner, 2026-11-02). Offboarding reads `/proc` on Linux instead
  of `lsof`. `node-patch` fetches the Linux build. A refresh step with under 50 ms left is no longer started.
  `test/portable.test.js` guards against the BSD-only forms coming back. Every Linux row passes:

  | Row | Baseline (0.9) | After 0.3 |
  | --- | --- | --- |
  | Debian 13 | 386 / 403 | 414 / 415 ✓ |
  | Ubuntu 26.04 | 387 / 403 | 414 / 415 ✓ |
  | Fedora 44 | 384 / 403 | 414 / 415 ✓ |
  | openSUSE Leap 16.0 | 386 / 403 | 414 / 415 ✓ |
  | openSUSE Tumbleweed | 386 / 403 | 414 / 415 ✓ |

  The one not counted on each row is the macOS-only host report test, skipped there.
  - [x] Done in 0.7 (#97): the RuVector add-on check names `ruvector-core-darwin-arm64` (`supply-chain/bin/addon-check.js`)
    rather than the add-on for this platform. It runs only with the AI tooling add-on, so no test caught it; it moves
    with 0.7.
- [x] **0.4 Indicators of compromise on every platform** (#89, D67). Linux lists processes from `/proc` (minimal
  installs have no `ps`); IOCs gain an `environment` list apart from `processes`; the sweep opens with a coverage line;
  "couldn't look" is never "clean" (owner, 2026-11-02). Found on the way: **macOS shows no process environment**, so the
  LiteLLM marker had never been checkable on a Mac (confirmed in the owner's terminal, macOS 27.2); the audit now says
  so. Python packages are also searched in `dist-packages` and the per-user folders on Linux and macOS. Every Linux row
  passes (423 of 424 each; the other is the macOS-only test, skipped).
- [x] **0.5 Trust store, the finding half** (#90, D68). The `trust` check runs on Linux too: the family's system CA
  bundle, then Linuxbrew's and Node's roots. A root still trusted is an action; a bundle that can't be found is a note.
  The Mac's audit is unchanged. **Found:** run with the engine's defaults in the test images, `emSign ECC Root CA - G3`
  is still trusted in the Fedora 44 and Tumbleweed images (p11-kit's `trust list` agrees), and not in Debian, Ubuntu or
  Leap.
- [x] **0.6 `steward doctor` per platform** (#91, D69). Prerequisites say where they apply, and their hints come per
  family; the doctor never runs `sudo`. Linux adds `Linux`, `libatomic` (Node 26's x64 and arm64 builds both need it)
  and `sha256sum`; `jq` comes from mise on every platform, as `yq` and `gh` do (owner, 2026-11-02). The Mac's `steward doctor` is
  byte-identical. Since the doctor can't report a missing `libatomic` (Node won't start), `docs/prereqs.md` gives a
  first-run order per family that installs it first. A follow-up (#95): a required mise tool missing from your own
  `mise/config.toml` gets the line to add, by hand, instead of an install that won't stick (owner, 2026-11-02).
- [x] **0.7 Words, and the RuVector add-on name** (#97, D73). Messages say "this machine" (owner, 2026-11-02); the
  audit's "Next:" line and the vulns coverage name only what applies here; the help texts are platform-neutral; the
  add-on is named for this OS, CPU and C library, with none (not a failure) where RuVector ships none. Found and fixed
  on the way: a test file that ended early yet passed, and doctor tests that wrote receipts into the real state folder.
- [x] **0.8 The first Linux CI row** (#100, D74). `test-linux` runs on every PR beside `test-macos`, and one required
  check, `test`, passes only when both did (owner, 2026-11-02). It checks Milestone 0's exit criterion: the audit
  without Homebrew and with Linuxbrew, and the plan, on Ubuntu. A release is tested on Linux too. Found and fixed on
  the way: a crash without Homebrew and a step that failed without an app folder. Publishing moves to Linux, and
  `package.json` `os` gains `linux`, only at the release step (R-3; owner, 2026-11-02).
- [x] **0.9 Test each distribution locally, in containers** (#87, D65; owner, 2026-11-01). `just linux-test <distro|all>`
  builds one image per distribution from a base pinned by digest (Renovate keeps it current, behind the gate), with
  bash, git, just and Node 26. It runs `just test` on a read-only copy of the checkout as a non-root user, with no
  network, in a container removed after the run (`--rm`). Results go to a file under the state folder;
  `just linux-clean` removes the test images after a plan and a yes. The same list as the CI matrix (T.1) feeds it.
  It adds to the CI matrix and never replaces it: every supported distribution still gets its CI job on every PR, and
  its install-check row (owner, 2026-11-01).
  Containers run arm64 on an Apple-silicon Mac (x64 by emulation) and have no systemd, so the NixOS VM stays in CI.
  Linux Mint's rows joined with the apt provider (1c, #103): `linuxmintd` is the Mint project's own account, the one
  its CI pushes to, and its images are amd64 only. (#87 said Mint has no official image; that was wrong.) Tumbleweed's row
  pins a `latest` digest: its dated snapshots that pass the gate have no arm64 build. The digest pinned on 2026-11-02
  ran under a recorded gate exception until it passed the gate on its own; the exception came out on 2026-11-05 (D80,
  #109). `latest` is rebuilt about daily, so Renovate's 3-day gate may never move the pin; `linux-test` dates the pin
  from git and warns (STALE PIN) once it is more than 30 days old, so a pin Renovate never moves gets noticed and
  repinned by hand (owner, 2026-11-04).

**The first Linux baseline** (`just linux-test all`, 2026-11-02, arm64): the work list for 0.3 to 0.8.

| Row | Pass | Fail |
| --- | --- | --- |
| Debian 13 | 386 / 403 | 16 |
| Ubuntu 26.04 | 387 / 403 | 15 |
| Fedora 44 | 384 / 403 | 18 |
| openSUSE Leap 16.0 | 386 / 403 | 16 |
| openSUSE Tumbleweed | 386 / 403 | 16 |

- On every row (15): mostly `mktemp -t` in `lib/lib.sh`, through `quiet` and `run_shown`: verify, `upgrade-tool`,
  `install-hybrids`, lock-age and the release check. Offboarding needs `lsof`. All are 0.3.
- On some rows (4): the declared-updater apply (Fedora, Leap, Tumbleweed); the AQE gates' `mark()` and a `run_shown`
  dry run (Fedora); the refresh time cap (Debian, perhaps timing). 0.3 looks into each.

## Milestone 1: Linux, one package manager at a time

**Goal:** each package manager is a provider that lists what is installed and behind, dates each version for the
gate, upgrades with a plan, a yes, a backup and a receipt, and says how to go back. Order, as in
[`../lifecycle.md`](../lifecycle.md#platforms): apt, dnf and zypper first, for the Linux release (R-1); then the other
fully supported providers; then the best-effort ones (owner, 2026-10-31 and 2026-11-01).

**Each provider's checklist** (one PR each; copy it into the provider's section when the work starts):

- step 0, before any code: the date source (or snapshot source) checked against the live service and cited; if
  there is none, the provider takes nothing and holds every update for review;
- the provider: installed and outdated;
- the release-age gate in its mode (D-a);
- upgrade: plan, yes, backup, receipt;
- the way back, or the plan saying there is none;
- OS updates, through the provider;
- `steward doctor` install hints;
- a CI row for the oldest and newest supported release;
- an install-check row;
- an end-to-end run in a container, `just linux-test <id> --e2e` (owner, 2026-11-02): network on, older packages
  seeded, then `steward sc plan` (its takes and holds checked against the real repo dates), `steward sc upgrade` with
  the test playing the user for the root hand-off (D-b), verify, and rollback where the manager has one. Run before
  the provider is ticked, not on every PR;
- docs and a D-row.

**apt's step 0** (2026-11-03): Debian is dated by snapshot.debian.org (a version's first sighting in `debian` or
`debian-security`), Ubuntu and Mint's Ubuntu base by Launchpad (`getPublishedBinaries`, the earliest publication in
Release, Updates or Security); both answered for real. Mint's own repo has no dated source, so a version there is dated
by the first-seen clock (owner, 2026-11-03). apt is built in three PRs, 1a to 1c (owner, 2026-11-03).

**apt's upgrade (1b, D76):** each package is pinned to the version the plan judged (`tzdata=2026f-0+deb13u1`), through
D-b's hand-off (`lib/roothandoff.js`, shared with dnf and zypper). Root first refreshes the system's own package lists
(`sudo apt-get update`), because they can be older than the steward's copy; the first real run in the Debian container
failed safely without it (`Version '2026f-0+deb13u1' for 'tzdata' was not found`), so the owner chose the refresh
(2026-11-03). A version from a security pocket (`trixie-security`, `noble-security`) is taken at once and says so
(owner, 2026-11-03). The receipt keeps before, after and why; the way back offers only versions the repos still have
(`apt-cache madison` from the steward's lists), and `steward sc rollback <receipt>` puts them back the same way.
Proven in the Debian 13 container, 2026-11-03: a real `tzdata` upgrade at a terminal, its rollback, and a hand-off
finished by `--resume`.

**apt's rows and the real-repo run (1c, D77, #103):** seven container rows, each the oldest or newest supported
release: Debian 12 and 13, Ubuntu 22.04 and 26.04, Linux Mint 21.3 and 22.3, and LMDE 7. LMDE is dated by
snapshot.debian.org, since its os-release names a `DEBIAN_CODENAME` and no `UBUNTU_CODENAME`. Mint's images come from
`linuxmintd` on Docker Hub, the account Mint's own CI pushes to (linuxmint/github-actions, `do-builds.yml`); they are
amd64 only, so on an Apple-silicon Mac they run under emulation. **The Mint 22.3 quirk:** its image ships Ubuntu's
`base-files`, so its os-release says Ubuntu. The row installs Mint's own `base-files` (`13ubuntu10mint22.3.0`, from
Mint's `import` component), so the steward sees Linux Mint, as on a fresh install (owner, 2026-11-03).
`just linux-test <id> --e2e` runs the whole cycle against the real repositories; all seven rows passed on
2026-11-03:

| Row | Checks | What it showed |
| --- | --- | --- |
| Debian 12 | 14 / 14 | security fixes from `oldstable-security` taken at once; upgrade, rollback, hand-off and `--resume` |
| Debian 13 | 15 / 15 | `tzdata` 2026f dated 4 days old by snapshot.debian.org and taken; the same steps |
| Ubuntu 22.04 | 14 / 14 | the same steps, from `jammy-security` |
| Ubuntu 26.04 | 14 / 14 | the same steps, from `resolute-security` |
| Linux Mint 21.3 | 95 / 95 | every age in the plan matched Launchpad's, within a day |
| Linux Mint 22.3 | 144 / 144 | Launchpad's ages matched; Mint's own packages (`xapps-common`, `mint-dev-tools`) first seen here, held |
| LMDE 7 | 57 / 57 | security fixes taken at once; `mint-dev-tools` first seen here, held |

Mint 21.3 had no package from Mint's own repo waiting, so its first-seen hold was seen only on 22.3 and LMDE 7.

**apt's install-check row (1d, D78, #107):** the install check runs on the Mac and on every row of `matrix.json`, the
same list as the tests (owner, 2026-11-03), from any commit (`-f ref=<sha>`) or a release (`-f version=X.Y.Z`); see
[the testing section](#testing-the-ci-matrix-and-install-checks). Each Linux row starts from its test image with a
fresh home and an empty mise, so `mise install` downloads the toolchain as a new user's would (owner, 2026-11-03).
apt's box counts as ticked when worktree mode passes on its seven rows; npm mode on Linux waits for the release, whose
`package.json` `os` first names `linux` (the bar's last box, R-2; owner, 2026-11-03). LMDE has one row: Mint's release
page lists LMDE 7 alone (checked 2026-11-03). Run here on 2026-11-03 with `just linux-test <id> --install-check`:
Debian 13 passed in 2 min 40 s, Linux Mint 21.3 (emulated) in 2 min 51 s; Debian 13's first try failed on a DNS
lookup for sigstore's TUF root while mise verified jq, and passed when run again. Then in CI, on the branch before it
merged (run 41682387384, 2026-11-03, marked as not counting for the bar): the Mac and all ten rows passed, each in
36 s to 1 min 15 s, Fedora 44, Leap 16.0 and Tumbleweed included.

**apt's OS updates (1e, D79, #108):** point releases and new kernels arrive as apt packages, which the apt source
already dates, gates and upgrades. `steward sc audit` adds a read-only "OS updates" section on Debian, Ubuntu, Mint and
LMDE, as the Mac's `softwareupdate` section does (owner, 2026-11-03):

- **A restart:** an action when `/run/reboot-required` exists (Ubuntu and Mint write it; it names the packages) or the
  running kernel (`uname -r`) is older than the newest installed `linux-image-*`, since Debian writes no file (owner,
  2026-11-03). A container has no kernel package, so there only the file is read, and the section says so.
- **A newer release:** a note, never planned, since a release upgrade is a major and done by hand.
- **The end of free security support** (D-c's cap): a note within 90 days, an action once past (owner, 2026-11-03).

The dates come from distro-info-data (`debian.csv`: `eol-lts`, else `eol`; `ubuntu.csv`: `eol`, LTS rows only) and,
for Mint and LMDE, Mint's release page, `download_all.php` (owner, 2026-11-03, over saying Mint isn't checked), each
fetched once a day. A source that can't be fetched, or no longer reads as it did, says "not checked", never "up to
date". The kernel fact was checked first: on Ubuntu, `apt-get install --only-upgrade linux-headers-generic=<new>`
pulls in the new ABI's packages, so a kernel upgrade through the steward installs the new kernel. `--e2e` now plants a
restart and checks the section against the live sources; all seven rows passed on 2026-11-03:

| Row | Restart | Free support until | Newer release |
| --- | --- | --- | --- |
| Debian 12 | action | 2028-06-30 | Debian 13 (trixie) |
| Debian 13 | action | 2030-06-30 | none |
| Ubuntu 22.04 | action | 2027-06-01 | Ubuntu 26.04 LTS (resolute) |
| Ubuntu 26.04 | action | 2031-05-29 | none |
| Linux Mint 21.3 | action | 2027-04-30 | Linux Mint 22.3 |
| Linux Mint 22.3 | action | 2029-04-30 | none |
| LMDE 7 | action | no end date published | none |

Each end date matched the row's `supported_until` in `matrix.json`, and each newer release matched the live source.
The kernel comparison runs on a real machine only; the containers prove it through the tests' canned `dpkg-query`.

**dnf's step 0** (2026-11-11, checked live in Fedora 43, 44 and 45 containers):

- **The date:** [Bodhi](https://bodhi.fedoraproject.org/), Fedora's update system, gives each update's `date_stable`,
  the moment it went to the stable `updates` repo, by advisory (`/updates/?alias=…`, many in one request) or by source
  build (`/updates/?builds=…`); no sign-in, no rate-limit headers seen. The repo's own metadata names each version's
  advisory (`dnf5 advisory list --json`), and all 46 updates pending in the Fedora 44 image had one. **Its issued time
  is not the date:** it matched `date_stable` on 126 of 132 advisories across Fedora 43, 44 and 45, but the other 6,
  all made stable in that day's compose, still carried the day they went to testing (`FEDORA-2026-97b00a408b`, vim:
  issued 2026-11-10 02:52:25, stable 2026-11-11 01:02:59; `FEDORA-2026-b630871014`: 15 days early). Taken as the date,
  that would let an update past the gate early, so the advisory gives the id and the type, and Bodhi the date. An
  RPM's build time is no date either: it came 1 to 16 days before `date_stable` (`pcre2-10.49-1.fc44`: built
  2026-10-23, stable 2026-11-08). Koji, the build system, knows only build times. A version only in the release's
  own `fedora` repo is dated by the release's day (Bodhi's `released_on`, null for Fedora 43). A version in
  `updates-testing` has no stable date and is never read.
- **Security:** each advisory has Bodhi's type, and `security` is the one that counts; severity is sometimes unset
  on a security update (`dnf5-5.4.7.0-1.fc44`, FEDORA-2026-97ca946ad2), so the type decides.
- **The way back:** `dnf5 history undo` failed on Fedora 44 after a `tzdata` 2026c → 2026f upgrade ("no match for:
  tzdata-2026c-1.fc44"), because the `updates` repo keeps only the newest build; `dnf5 list --showduplicates` offers
  only the release's build and the newest update. `dnf5 downgrade` works, to a version the repos still offer: here
  2026a, the release's. An exact pin works (`dnf5 upgrade tzdata-2026f-1.fc44`). This shapes dnf 1b.
- **OS updates:** `dnf5 needs-restarting -r` exits 1 and names glibc after a glibc upgrade, in a container and as a
  normal user; Bodhi's releases give each release's end and the newer releases.
- **As the user:** `dnf5` with its own `cachedir` reads every repo, the advisories included, without root, and leaves
  the system's cache alone (about 100 MB).

**dnf's read-only source (1a, D81):** `lib/providers/dnf.js`, for the rhel family, dnf5 only (Fedora's dnf since 41).
It lists what dnf would upgrade from its own cache under the steward's state folder, as the user, never reading a
testing repo, and dates each new version by Bodhi's `date_stable` for its advisory (one request for all of a run's
advisories, cached for the day), else for its source build, else the release's day for a version only in the
release's repo, else the first-seen clock, as on Mint; a Bodhi that can't be reached gives the first-seen clock too,
never the advisory's issued time. A version whose advisory is of type security is taken at once and names the
advisory, as apt's security pockets are. Until 1b brings the upgrade, the plan lists each update past the gate with its
exact `sudo dnf5 upgrade -y <name>-<version>.<arch>` line, and `apply` refuses the source. Live, as the unprivileged
user in both row images (2026-11-11): all 16 pending updates on Fedora 44 and 18 on Fedora 45 dated by Bodhi; `tzdata`
2026f 5 and 4 days old, taken; `pcre2` 10.49 and `curl` taken at once on their security advisories; vim's fix of that
morning held at 0 days; the system's dnf cache untouched. **The rows:** Fedora 44
(oldest) and Fedora 45 (newest). Docker Hub's `fedora:45` is the prerelease image (pushed 2026-11-02, the day before
the release): its `fedora-repos` 45-0.6 turns `updates-testing` on, so the row installs the release's `fedora-repos`
45-1 first, as a fresh install has it.

| Provider | Distributions | Gate mode (D-a) | Stage | PR |
| --- | --- | --- | --- | --- |
| ✅ apt | Debian, Ubuntu, Linux Mint, LMDE (the Linux release) | per package | Done: 1a read-only (#101, D75); 1b the upgrade with the sudo hand-off (#102, D76); 1c the rows, CI and the real-repo run (#103, D77); 1d its install-check row (#107, D78); 1e OS updates, read-only (#108, D79). npm mode on Linux waits for the release (R-2) | #101, #102, #103, #107, #108 |
| 🟨 dnf | Fedora (the Linux release) | per package | Under way: step 0 (2026-11-11); 1a read-only (#112, D81) | #112 |
| ⬜ zypper | openSUSE Leap, Tumbleweed (the Linux release) | per package (D-a); the zypper PR checks how Tumbleweed's rolling updates fit | Not started | |
| ⬜ Flatpak | any | per package | Not started | |
| ⬜ Snap | Ubuntu and others | per package | Not started | |
| ⬜ pacman | Arch | dated snapshot | Not started | |
| ⬜ apk | Alpine | per package | Not started (feasibility spike first) | |
| ⬜ xbps | Void (best effort) | dated snapshot | Not started | |
| ⬜ portage | Gentoo (best effort) | dated snapshot | Not started | |
| ⬜ slackpkg | Slackware (best effort) | to find out | Not started | |

## Milestone 2: Linux apps and trust stores

**Goal:** what the Mac's app, Electron and trust checks do, on Linux.

Stage: Not started.

- [ ] **2.1 Trust store, the denying half, per family:** Debian (`update-ca-certificates`), Red Hat (`update-ca-trust`),
  SUSE, Arch and Alpine. It needs root, so it goes through D-b's hand-off (sudo at your terminal, else handed over). First test cases: the
  Fedora 44 and Tumbleweed images, which still trust `emSign ECC Root CA - G3` (found by 0.5).
- [ ] **2.2 Apps and the Electron support window** for Flatpak, Snap, AppImage and `/opt`.
- [ ] **2.3 Vendored Node on Linux:** Linux paths in the engine's `vendored_node` defaults.
- [ ] **2.4 Browsers kept current on Linux:** Linux names in the engine's `always_current` defaults.
- [ ] **2.5 Indicators of compromise:** Linux locations added to the engine's defaults as advisories name them.
- [ ] **2.6 An optional endpoint source, later** (owner, 2026-11-02): for what `ps` can't see on macOS (process
  environments), an opt-in source such as osquery, installed and gated like any other tool. Nothing built yet.

## Milestone 3: NixOS

**Goal:** a NixOS host keeps its supply chain current the declarative way: the whole system moves to a dated nixpkgs
revision, is built and compared before it is switched on, and can go back a generation.

Stage: Not started. Comes after Linux and before Windows (D-e).

- [ ] **3.1 Can CI run a NixOS VM?** Check whether `ubuntu-latest` offers `/dev/kvm` for a `nixosTest`. The
  `nixos/nix` container has no systemd, so it covers only Nix on another Linux.
- [ ] **3.2 The `nix` provider, flakes:** move nixpkgs to the newest revision at least the gate's days old (from
  `flake.lock`), build it, show the closure diff, switch on a yes; the way back is the previous generation.
- [ ] **3.3 Channels:** the same for hosts that use channels instead of a flake.
- [ ] **3.4 Changes to the host's Nix config** (packages, `security.pki`) go as a PR to the repo it lives in, never as an
  edit in place (D6).
- [ ] **3.5 mise on NixOS:** mise from nixpkgs, with `nix-ld` turned on by a PR to the host's config (D-g).
- [ ] **3.6 An advisory source for Nix** (for example `vulnix`), checked and cited first.

## Testing: the CI matrix and install checks

**The axes.** Every combination is one cell:

1. distribution and package manager, from [the table above](#supported-platforms-and-minimum-versions), with Linuxbrew
   as an overlay on Ubuntu and Fedora;
2. its oldest and newest supported release (D-c);
3. CPU: x64 and arm64;
4. where mise comes from: its own installer, the distribution's package, or Homebrew;
5. how the steward is installed: a worktree at the tag, or the npm package.

**Where each cell runs.**

| Tier | When | Cells |
| --- | --- | --- |
| Tests | every PR | macOS; `ubuntu-latest` on x64 and arm64; a container for every row in `test/containers/matrix.json` (owner, 2026-11-03) |
| Install check | by hand: from a commit before a release (`gh workflow run install-check.yml -f ref=<sha>`), from the release after it (`-f version=X.Y.Z`) | macOS and every row in `test/containers/matrix.json` (owner, 2026-11-03) × mise's own release file × {worktree, npm}; npm only where the release's `package.json` `os` names the platform; Linuxbrew on Ubuntu; a NixOS VM |
| Extended | by hand, before a platform is called supported | mise from the distribution and from Homebrew; arm64 install checks |
| Not supported | ➖ | any cell not above, listed in [`../lifecycle.md`](../lifecycle.md#platforms) |

- [x] **T.1** (#103) One list feeds both matrices, so a new provider adds its rows in one place: `test/containers/matrix.json`.
  CI's `rows` job reads it (`node tools/linux-test.js ci`), and `test-containers` runs each row the way
  `just linux-test` does, on the example toolchain's Node through the pinned mise-action. `test` needs both.
- [x] **T.2** (#100) Tests on `ubuntu-latest` (x64) with Linuxbrew and mise (Milestone 0).
- [ ] **T.3** Tests on arm64 Linux.
- [x] **T.4** (#107) The install check as a matrix, with a Linux row: a `rows` job reads `matrix.json`, and a `macos`
  job and one `linux` job per row each run `tools/install-check.sh`, the rows through `linux-test.js run <id>
  --install-check`, as `just linux-test` runs them locally.
- [x] **T.5** (#103) Container rows join with each provider (Milestone 1): every row in `matrix.json` runs on every PR,
  so a provider's rows join CI when it adds them there. apt's seven did in 1c.
- [ ] **T.6** The NixOS VM row (Milestone 3).
- [x] **T.7** (#107) The install check takes a `ref`: worktree mode from any commit of `main`, so Linux rows run before the
  release (R-2). npm mode stays for released versions. A commit not on `main` runs too, and its summary says it
  doesn't count for the release bar (owner, 2026-11-03). The tooling comes from the workflow's own commit, what is
  installed from the ref or the tag, since an older tag has neither the script nor the list.

> [!IMPORTANT]
> Linux runners and containers cost nothing on the public repo. macOS rows keep running by hand on a private copy,
> as they do today.

## Facts to verify

These shaped the plan but were not checked when it was written. Each is checked against a primary source, and cited,
in the PR that relies on it.

- [ ] Arch doesn't support partial upgrades, and the Arch Linux Archive serves repos by date.
- [ ] Each package manager's date source: Fedora's Bodhi (checked 2026-11-11, dnf's step 0), Debian's and Ubuntu's publishing history or snapshot
  services, Alpine's index, openSUSE's, Void's and Slackware's.
- [ ] `dnf history undo` on dnf5 (checked 2026-11-11, dnf's step 0: it exists, and fails whenever the version before
  was an earlier update, since Fedora's `updates` repo keeps only the newest); the pacman cache and snapper as ways back.
- [ ] How each family denies a root: `update-ca-certificates`, `update-ca-trust`, p11-kit's blocklist.
- [x] The oldest glibc Node 26's Linux binaries need (2.28), and mise's (2.18): measured 2026-11-03; see
  [the minimum versions](#supported-platforms-and-minimum-versions).
- [x] Node 26's Linux arm64 binary needs `libatomic.so.1` (seen on all five rows of 0.9's first run, 2026-11-02).
- [ ] Node 26 on Alpine: official tarballs have no musl build, and Alpine's package may be older than 26.
- [ ] mise on NixOS: in nixpkgs; the tools it downloads need `nix-ld`.
- [ ] GitHub's arm64 Linux runners for public repos, and `/dev/kvm` on `ubuntu-latest`.
- [ ] `vulnix` as an advisory source for Nix.

## Changes to this ledger

| Date | Revision | Change | PR |
| --- | --- | --- | --- |
| 2026-11-11 | 20 | dnf step 0 (Bodhi, the advisories, `history undo`, the releases) and dnf 1a: the dnf source, read-only (D81); the Fedora rows are 44 (oldest) and 45 (newest, its prerelease image's testing repo turned off); Fedora's minimum versions | #112 |
| 2026-11-05 | 19 | Tumbleweed's pin passed the gate and its exception came out; a rolling row's pin is dated by git and warned of past 30 days (D80) | #109 |
| 2026-11-04 | 18 | apt 1e done, and apt done: OS updates as a read-only audit section (a restart, a newer release, the end of free security support), checked on all seven apt rows (D79) | #108 |
| 2026-11-03 | 17 | apt 1d done: the install check as a matrix from a ref, on the Mac and every `matrix.json` row (T.4, T.7, D78); how LMDE fits; OS updates decided for 1e | #107 |
| 2026-11-03 | 16 | apt 1c done: the minimum versions (what counts as security support), seven apt rows with Mint and LMDE, every row in CI from one list (T.1, T.5), `--e2e` passing on all seven apt rows, the glibc fact (D77) | #103 |
| 2026-11-03 | 15 | apt 1b done: D-b revised, the upgrade through sudo at your terminal or handed over (D76) | #102 |
| 2026-11-03 | 14 | apt 1a done: the read-only source, its dates from snapshot.debian.org, Launchpad or the first-seen clock (D75) | #101 |
| 2026-11-02 | 13 | 0.8 done, Milestone 0 complete: the tests on Linux in CI behind one required check, the exit criterion green (D74); T.2 done | #100 |
| 2026-11-02 | 12 | 0.7 done: the words, the per-platform lists, the RuVector add-on name (D73); Milestone 0 has only 0.8 left | #97 |
| 2026-11-02 | 11 | 0.6 follow-up: the doctor names a mise tool missing from your own toolchain | #95 |
| 2026-11-02 | 10 | 0.6 done: steward doctor per platform (D69); the Linux first-run order | #91 |
| 2026-11-02 | 9 | 0.5 done: distrusted roots found on Linux (D68); emSign still trusted in the Fedora 44 and Tumbleweed images, the first cases for 2.1 | #90 |
| 2026-11-02 | 8 | 0.4 done: IOCs on every platform, the environment key, the coverage line, the rule (D67); macOS shows no process environment; 2.6 added for later | #89 |
| 2026-11-02 | 7 | 0.3 done: the shell on GNU and busybox, no perl, no lsof on Linux (D66); every Linux row passes; jq joins the Linux prerequisites; the Mint image corrected; the RuVector add-on name moves to 0.7 | #88 |
| 2026-11-02 | 6 | 0.9 done: local container tests (D65), the first Linux baseline, the libatomic finding; end-to-end runs added to each provider's checklist and the release bar | #87 |
| 2026-11-01 | 5 | 0.2 done: package sources with one contract, judged in one place (D64) | #86 |
| 2026-11-01 | 4 | The Linux release bar (R-1 to R-3): apt, dnf and zypper first; 0.8 keeps `os` Mac-only until the bar; T.7 install check from a commit | #84 |
| 2026-11-01 | 3 | 0.1 done: the distribution and family from os-release, and `host.toml`'s `families` key (D63); 0.9 added: local container tests; Milestone 0 under way | #84 |
| 2026-10-31 | 2 | Decisions D-a to D-g made and written in; minimum-version rule (n-3, capped) and support level filled in for each distribution; NixOS moves ahead of Windows, and fully supported providers ahead of best-effort ones, in `lifecycle.md` | #83 |
| 2026-10-31 | 1 | First version: the plan, the two decisions made, the open ones, every milestone not started | #82 |
