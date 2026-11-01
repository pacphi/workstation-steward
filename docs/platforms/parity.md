# Linux and NixOS parity

![Revision 3](https://img.shields.io/badge/Revision-3-green) ![Revised 2026-11-01](https://img.shields.io/badge/Revised-2026--11--01-green)

The plan and the progress ledger for bringing the steward from macOS to Linux distributions and NixOS. Every PR in
this work ticks its boxes here and links itself, so this page always says what is done, what is under way and what
is left.

- [Why this matters](#why-this-matters)
- [Where we are](#where-we-are)
- [How to use this ledger](#how-to-use-this-ledger)
- [Decisions](#decisions)
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
| [0. Portable engine](#milestone-0-a-portable-engine) | The engine runs on Linux with Linuxbrew and mise; the Mac's output is unchanged | Under way | 1 / 9 |
| [1. Linux providers](#milestone-1-linux-one-package-manager-at-a-time) | System packages per package manager, gated and reversible | Not started | 0 / 10 |
| [2. Linux apps and trust](#milestone-2-linux-apps-and-trust-stores) | Flatpak, Snap, AppImage and the Electron window; trust store per family | Not started | 0 / 5 |
| [3. NixOS](#milestone-3-nixos) | The flake or channel as a whole, with generations as the way back | Not started | 0 / 6 |
| [Testing](#testing-the-ci-matrix-and-install-checks) | A CI row and an install-check row for every combination we claim | Not started | 0 / 6 |
| [Decisions](#decisions) | The choices the work depends on | All made | 9 / 9 |

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
- [x] **D-b. Root steps are handed to the user** (owner, 2026-10-31). The steward plans, and backs up what it can as
  the user. Then it prints one exact `sudo` command for the user to run in their own terminal (`actor: human`). After
  that it checks the result and writes the receipt. It never runs `sudo` itself, and it never runs under `sudo`, so
  receipts and backups stay the user's.
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

| Distribution | Package manager | Kind | Minimum version | Support | Provider |
| --- | --- | --- | --- | --- | --- |
| Debian | apt | fixed releases | n-3, capped (numbers in the apt PR) | Full | ⬜ |
| Ubuntu | apt | fixed releases | n-3 of the LTS releases, capped (numbers in the apt PR) | Full | ⬜ |
| Linux Mint | apt | fixed releases | n-3, capped, on a supported Ubuntu LTS base | Full | ⬜ |
| Fedora | dnf | fixed releases | n-3, capped (in practice the vendor supports two) | Full | ⬜ |
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
| OS updates | `softwareupdate -l` | part of the system provider | moving nixpkgs is the OS update | ⬜ |
| Apps and the Electron window | `/Applications`, casks | Flatpak, Snap, AppImage, `/opt` | Nix apps; Flatpak where enabled | ⬜ |
| App store | `mas` | Flatpak and Snap stand in | ➖ | ⬜ |
| Trust store: finding distrusted roots | keychain, PEM bundles, Node's roots | PEM bundles and Node's roots (portable today), the system bundle | the system bundle | ⬜ |
| Trust store: denying a root | admin trust setting (by hand) | per family: Debian, Red Hat, SUSE, Arch, Alpine | `security.pki` in the host's config, by a PR | ⬜ |
| Indicators of compromise | `ps`, Mac paths | procps or busybox `ps`, `/proc`, Linux paths | `/nix/store` paths | ⬜ |
| `steward doctor` install hints | Homebrew, mise | per package manager | per Nix setup | ⬜ |
| Fleet, projects, AI tooling | ✅ | already portable (git, gh, XDG paths), apart from the qualify scripts fixed in Milestone 0 | as Linux | ⬜ |

## Milestone 0: a portable engine

**Goal:** the steward runs on Linux with only the Homebrew and mise providers, and a Mac prints the same output as
before. **Done when:** `steward sc plan` and `steward sc audit` run clean on `ubuntu-latest` with Linuxbrew, and the
Mac's output before and after is identical.

Stage: Under way (0.1 done).

- [x] **0.1 Know the platform** (#PR, D63). `lib/platform.js` reads `/etc/os-release` (`ID`, `ID_LIKE`, `VERSION_ID`) and returns
  the platform, distribution and family; NixOS by `ID=nixos`. `host.toml` entries take the optional `families` key
  (D-f), and `lib/host.js` checks it as it checks `platforms`. An entry with `families` must also say
  `platforms = ["linux"]`, and the steward warns when it doesn't (owner, 2026-11-01). Tests use sample os-release
  files for every row of the platforms table, and two that only `ID_LIKE` places.
- [ ] **0.2 One contract for providers.** A written interface: `id`, `platforms`, `families`, `gateMode`, `available`,
  `installed`, `outdated`, `releaseDate` or `snapshot`, `upgradeCmd`, `needsRoot`, `canRollback`, `rollbackCmd`.
  `supply-chain/bin/upgrade.js` loops over the providers that apply instead of calling Homebrew directly. Proof: the
  Mac's `steward sc plan` output is identical before and after.
- [ ] **0.3 Bash that runs on GNU and busybox.**
  - The blocker: `mktemp -t steward-quiet` in `lib/lib.sh` fails on GNU, so every script that uses `quiet` or
    `run_shown` stops on Linux.
  - APFS clones (`cp -c`) become a helper that uses `cp -a --reflink=auto` on GNU, where `-c` means something else.
  - `mv -h` becomes `mv -T`; `shasum` falls back to `sha256sum`; BSD date arithmetic moves to Node.
  - `node-patch` picks Linux tarballs; the RuVector add-on check names the add-on for this platform; offboarding stops
    needing `lsof`.
- [ ] **0.4 Indicators of compromise on Linux.** `ps` per flavor (BSD, procps, busybox), `/proc` where `ps` can't show
  the environment, and Linux paths.
- [ ] **0.5 Trust store, the finding half.** The PEM-bundle and Node-roots checks leave the macOS-only trust check, so
  Linux reports distrusted roots from the start.
- [ ] **0.6 `steward doctor` per platform.** Each prerequisite says which platforms need it. Today `sw_vers`,
  `security`, `softwareupdate`, `mas` and Homebrew are required everywhere. Install hints come per family.
- [ ] **0.7 Words.** "This Mac" and macOS-only fix text become platform-aware in the review, the audit, the briefing,
  the guards and the package description.
- [ ] **0.8 Package and first Linux CI row.** `package.json` `os` adds `linux` (npm users see this, so release-please
  makes it a minor release); publish no longer needs macOS; Tests run on `ubuntu-latest` too.
- [ ] **0.9 Test each distribution locally, in containers** (owner, 2026-11-01). `just linux-test <distro|all>`
  builds one image per distribution from a base pinned by digest (Renovate keeps it current, behind the gate), with
  bash, git, just and Node 26. It runs `just test` on a read-only copy of the checkout as a non-root user, with no
  network, in a container removed after the run (`--rm`). Results go to a file under the state folder;
  `just linux-clean` removes the test images after a plan and a yes. The same list as the CI matrix (T.1) feeds it.
  It adds to the CI matrix and never replaces it: every supported distribution still gets its CI job on every PR, and
  its install-check row (owner, 2026-11-01).
  Containers run arm64 on an Apple-silicon Mac (x64 by emulation) and have no systemd, so the NixOS VM stays in CI.
  Built right after 0.2.

## Milestone 1: Linux, one package manager at a time

**Goal:** each package manager is a provider that lists what is installed and behind, dates each version for the
gate, upgrades with a plan, a yes, a backup and a receipt, and says how to go back. Order, as in
[`../lifecycle.md`](../lifecycle.md#platforms): the fully supported providers first, then the best-effort ones (owner,
2026-10-31).

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
- docs and a D-row.

| Provider | Distributions | Gate mode (D-a) | Stage | PR |
| --- | --- | --- | --- | --- |
| ⬜ apt | Debian, Ubuntu, Linux Mint | per package | Not started | |
| ⬜ dnf | Fedora | per package | Not started | |
| ⬜ Flatpak | any | per package | Not started | |
| ⬜ Snap | Ubuntu and others | per package | Not started | |
| ⬜ zypper | openSUSE Leap, Tumbleweed | per package (D-a); the zypper PR checks how Tumbleweed's rolling updates fit | Not started | |
| ⬜ pacman | Arch | dated snapshot | Not started | |
| ⬜ apk | Alpine | per package | Not started (feasibility spike first) | |
| ⬜ xbps | Void (best effort) | dated snapshot | Not started | |
| ⬜ portage | Gentoo (best effort) | dated snapshot | Not started | |
| ⬜ slackpkg | Slackware (best effort) | to find out | Not started | |

## Milestone 2: Linux apps and trust stores

**Goal:** what the Mac's app, Electron and trust checks do, on Linux.

Stage: Not started.

- [ ] **2.1 Trust store, the denying half, per family:** Debian (`update-ca-certificates`), Red Hat (`update-ca-trust`),
  SUSE, Arch and Alpine. It needs root, so the steward hands the user the exact command (D-b).
- [ ] **2.2 Apps and the Electron support window** for Flatpak, Snap, AppImage and `/opt`.
- [ ] **2.3 Vendored Node on Linux:** Linux paths in the engine's `vendored_node` defaults.
- [ ] **2.4 Browsers kept current on Linux:** Linux names in the engine's `always_current` defaults.
- [ ] **2.5 Indicators of compromise:** Linux locations added to the engine's defaults as advisories name them.

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
| Tests | every PR | macOS; `ubuntu-latest` on x64 and arm64; a container for the oldest and newest release of each distribution whose provider has landed |
| Install check | by hand, each release (`gh workflow run install-check.yml -f version=X.Y.Z`) | each fully supported distribution (D-d) × mise's own installer × {worktree, npm}; Linuxbrew on Ubuntu; a NixOS VM |
| Extended | by hand, before a platform is called supported | mise from the distribution and from Homebrew; arm64 install checks |
| Not supported | ➖ | any cell not above, listed in [`../lifecycle.md`](../lifecycle.md#platforms) |

- [ ] **T.1** One generated list feeds both matrices, so a new provider adds its rows in one place.
- [ ] **T.2** Tests on `ubuntu-latest` (x64) with Linuxbrew and mise (Milestone 0).
- [ ] **T.3** Tests on arm64 Linux.
- [ ] **T.4** The install check as a matrix, with a Linux row.
- [ ] **T.5** Container rows join with each provider (Milestone 1).
- [ ] **T.6** The NixOS VM row (Milestone 3).

> [!IMPORTANT]
> Linux runners and containers cost nothing on the public repo. macOS rows keep running by hand on a private copy,
> as they do today.

## Facts to verify

These shaped the plan but were not checked when it was written. Each is checked against a primary source, and cited,
in the PR that relies on it.

- [ ] Arch doesn't support partial upgrades, and the Arch Linux Archive serves repos by date.
- [ ] Each package manager's date source: Fedora's Bodhi, Debian's and Ubuntu's publishing history or snapshot
  services, Alpine's index, openSUSE's, Void's and Slackware's.
- [ ] `dnf history undo` on dnf5; the pacman cache and snapper as ways back.
- [ ] How each family denies a root: `update-ca-certificates`, `update-ca-trust`, p11-kit's blocklist.
- [ ] The oldest glibc Node 26's Linux binaries need, and mise's.
- [ ] Node 26 on Alpine: official tarballs have no musl build, and Alpine's package may be older than 26.
- [ ] mise on NixOS: in nixpkgs; the tools it downloads need `nix-ld`.
- [ ] GitHub's arm64 Linux runners for public repos, and `/dev/kvm` on `ubuntu-latest`.
- [ ] `vulnix` as an advisory source for Nix.

## Changes to this ledger

| Date | Revision | Change | PR |
| --- | --- | --- | --- |
| 2026-11-01 | 3 | 0.1 done: the distribution and family from os-release, and `host.toml`'s `families` key (D63); 0.9 added: local container tests; Milestone 0 under way | #PR |
| 2026-10-31 | 2 | Decisions D-a to D-g made and written in; minimum-version rule (n-3, capped) and support level filled in for each distribution; NixOS moves ahead of Windows, and fully supported providers ahead of best-effort ones, in `lifecycle.md` | #83 |
| 2026-10-31 | 1 | First version: the plan, the two decisions made, the open ones, every milestone not started | #82 |
