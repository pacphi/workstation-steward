# Prerequisites

![Revision 6](https://img.shields.io/badge/Revision-6-green) ![Revised 2026-11-02](https://img.shields.io/badge/Revised-2026--11--02-green)

Everything this repo needs on the machine, and where each piece comes from, on macOS and on Linux. The list lives in
[`lib/prereqs.json`](../lib/prereqs.json); the table below is printed from it, and a test keeps the two equal.
`steward doctor` shows only what applies to your platform (D69).

## Check it

```sh
steward doctor                      # read-only: the engine, your config's format and add-ons, then what is there and
                                    # what is missing; exit 1 if a required tool is missing
steward doctor --area core,fleet    # only those areas
steward doctor --install            # plan the missing mise and Homebrew tools, ask [y/N], install, write a receipt
```

`steward doctor` runs `node lib/doctor.js`, which needs only Node, so it works before `yq` is installed. Until `steward`
is on your PATH, run `node bin/steward.js doctor` from the clone.

## The order on a new Mac

Each step needs the one before it.

1. **Xcode command line tools** (`xcode-select --install`): gives `git`, `curl` and the macOS tools.
2. **Homebrew** (<https://brew.sh>), then **mise**, the standalone build: `curl https://mise.run | sh` puts it in
   `~/.local/bin`. From then on `steward sc upgrade-tool mise` updates it, age-gated, with a backup (D38).
3. `git clone` this repo, then `node bin/steward.js sc link`: point `~/.config/mise/` at this repo's `mise/config.toml`
   and `mise.lock`. Once `just` is installed (step 4), `just release-worktree <tag>` puts `steward` and `steward-dev` on
   your PATH (D41).
4. `mise install`: installs every tool pinned in `mise/config.toml`: `node`, `just`, `yq`, `jq`, `gh`, `shellcheck`,
   `lychee`, `npm` and the rest.
5. `brew install mas`, which is optional, as is Docker Desktop.
6. `gh auth login`, then `steward doctor`.

## The order on Linux

The steward isn't released for Linux yet ([the Linux release](platforms/parity.md#the-linux-release-the-bar)); this is
for running the engine from a clone. Install the system packages first, in one line for your family:

| Family | One line |
| --- | --- |
| Debian, Ubuntu, Linux Mint | `sudo apt-get install git curl ca-certificates libatomic1` |
| Fedora | `sudo dnf install git-core curl ca-certificates libatomic` |
| openSUSE | `sudo zypper install git-core curl ca-certificates libatomic1` |

> [!IMPORTANT]
> Install `libatomic` before `mise install`, which brings `jq` with the rest of the toolchain. Node 26's Linux builds need it, and `steward doctor` can't tell you it's
> missing, because Node won't start without it. Without it, `mise install` stops with:
> `node: error while loading shared libraries: libatomic.so.1: cannot open shared object file: No such file or directory`

Then mise (`curl https://mise.run | sh`), and steps 3, 4 and 6 of the Mac's order. Homebrew is optional on Linux
(Linuxbrew, formulae only).

## Services, outside this Mac

Two services on GitHub, set up once in a browser. `steward doctor` can't check them, so they're listed here.

- **A GitHub account, and `gh` logged in to it** (step 6). Your config repo lives there, and `steward review` reads
  open pull requests and alerts through it.
- **Renovate, a GitHub app by Mend.** Recommended. It proposes each toolchain update as a pull request, after the same
  3-day gate, and keeps one issue per repo, the **Dependency Dashboard**, listing what it holds back and why.
  `steward review` ("Waiting on the release-age gate") and `steward brief` read that dashboard, so without Renovate
  those parts stay empty. Install it on your config repo: [`config-repo.md`](config-repo.md#2-let-renovate-keep-it-current).
  Maintainers also install it on the engine repo ([`maintainers.md`](maintainers.md#renovate-on-the-engine-repo)).

The `renovate` command in the list below is a different thing: an optional tool for checking a `renovate.json` on
this Mac. The app does the real work on GitHub.

## The list

<!-- prereqs:start -->
| Area | Tool | Platforms | Need | From | Used for | To install |
| --- | --- | --- | --- | --- | --- | --- |
| core | macOS | macos | required | system | Its audit of Homebrew casks, the App Store, macOS updates and the macOS trust stores | comes with macOS |
| core | Linux | linux | required | system | os-release names the distribution and its family, which pick the package sources, paths and install hints (D63) | comes with the distribution |
| core | bash | all | required | system | Every supply-chain script. The macOS 3.2 is enough and is what they are written for | comes with the system |
| core | git | all | required | system | Project discovery, onboarding, sync, prune and every PR step | macos: `xcode-select --install`; debian: `sudo apt-get install git`; rhel: `sudo dnf install git-core`; suse: `sudo zypper install git-core` |
| core | curl | all | required | system | Registry, Homebrew and advisory lookups | comes with the system |
| core | mise | all | required | manual | Installs and pins every tool below; `steward sc` wraps it. The standalone build in ~/.local/bin; `steward sc upgrade-tool mise` updates it (D38) | `curl https://mise.run \| sh` |
| core | node | all | required | mise | lib/*.js, drift, onboarding, review, doctor and the tests | `mise install node` |
| core | libatomic | linux | required | system | Node 26's Linux builds (x64 and arm64) link libatomic.so.1, which minimal installs leave out | debian: `sudo apt-get install libatomic1`; rhel: `sudo dnf install libatomic`; suse: `sudo zypper install libatomic1` |
| core | yq | all | required | mise | Reads steward.toml and the policy files (`yq -p toml`) | `mise install yq` |
| supply-chain | Homebrew | all | macos: required; linux: optional | manual | `steward sc audit` and `steward sc upgrade` manage formulae and casks (formulae only on Linux, as Linuxbrew) | macos: `see https://brew.sh`; linux: `see https://docs.brew.sh/Homebrew-on-Linux` |
| supply-chain | npm | all | required | mise | Installs the npm -g hybrids (Ruflo, AgentDB) with a reviewed script allow-list | `mise install npm` |
| supply-chain | shasum | macos | required | system | `steward sc node-patch` checks the Node tarball against SHASUMS256 | comes with macOS |
| supply-chain | sha256sum | linux | required | system | `steward sc node-patch` checks the Node tarball against SHASUMS256 (in place of shasum) | comes with the distribution |
| supply-chain | security | macos | required | system | `steward sc audit` reads the macOS system roots and admin trust settings | comes with macOS |
| supply-chain | softwareupdate | macos | required | system | `steward sc audit` lists pending macOS updates | comes with macOS |
| supply-chain | mas | macos | optional | brew | `steward sc audit` checks the App Store; skipped with a warning when missing | `brew install mas` |
| supply-chain | Docker | all | optional | manual | `steward sc audit` checks running images and IOC digests; skipped when Docker is not running | macos: `install Docker Desktop`; linux: `install Docker Engine: https://docs.docker.com/engine/install/` |
| fleet | gh | all | required | mise | Every PR, review, issue and alert read; `steward review` and `steward fleet prune-merged` | `mise install gh` |
| fleet | gh login | all | required | manual | GitHub is the source of record for alerts and updates; the weekly review and prune-merged need a logged-in gh | `gh auth login` |
| fleet | jq | all | required | mise | The pr-consolidation scripts (lock-age, pr-status, merge-and-close …) and the release check parse gh and registry JSON. From mise on every platform, as yq and gh are | `mise install jq` |
| dev | just | all | optional | mise | Developer tasks only: `just test`, `lint`, `docs`, `links`, `release-worktree`. The steward itself runs as `steward` | `mise install just` |
| dev | shellcheck | all | optional | mise | `just lint` and the lock-age script check | `mise install shellcheck` |
| dev | markdownlint-cli2 | all | optional | mise | `just docs` Markdown lint | `mise install npm:markdownlint-cli2` |
| dev | lychee | all | optional | mise | `just docs` and `just links` link checks | `mise install lychee` |
| dev | renovate | all | optional | mise | Checking a renovate.json with `renovate --platform=local` | `mise install npm:renovate` |
<!-- prereqs:end -->

## What the install step does and does not do

`steward doctor --install` installs only what is missing and only from mise or Homebrew. For a mise tool it runs
`mise install <tool>`, which installs the version pinned in `mise/config.toml` and respects the release-age gate. For a
Homebrew tool it runs `brew install <formula>`. It shows the commands first, asks, runs them with a live timer, and writes
a receipt (`doctor-install-<time>/receipt.json` under the state folder's `backups/`). A receipt starts no soak, because
nothing already installed changes.

It never runs the Xcode tools, Homebrew itself, Docker or `gh auth login`. Those are listed for you to do by hand.

## Not covered here

- **The npm -g hybrids** (Ruflo, AgentDB): `steward sc verify` checks them, and `steward sc install-hybrids` installs them.
- **Per-project tools:** each project's own toolchain is its own repo's concern. See the repo's `AGENTS.md`.
