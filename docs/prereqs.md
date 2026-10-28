# Prerequisites

![Revision 3](https://img.shields.io/badge/Revision-3-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

Everything this repo needs on the machine, and where each piece comes from. The list lives in
[`lib/prereqs.json`](../lib/prereqs.json); the table below is printed from it, and a test keeps the two equal.

## Check it

```sh
steward doctor                      # read-only: what is there, what is missing, exit 1 if a required tool is missing
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
4. `mise install`: installs every tool pinned in `mise/config.toml`: `node`, `just`, `yq`, `gh`, `shellcheck`, `lychee`,
   `npm` and the rest.
5. `brew install jq mas`. The fleet scripts need `jq`, and `mas` is optional. Docker Desktop is optional.
6. `gh auth login`, then `steward doctor`.

## The list

<!-- prereqs:start -->
| Area | Tool | Need | From | Used for | To install |
| --- | --- | --- | --- | --- | --- |
| core | macOS | required | system | The steward audits Homebrew, the App Store and the macOS trust stores; it is macOS only | comes with macOS |
| core | bash | required | system | Every supply-chain script. The macOS 3.2 is enough and is what they are written for | comes with macOS |
| core | git | required | system | Project discovery, onboarding, sync, prune and every PR step | `xcode-select --install` |
| core | curl | required | system | Registry, Homebrew and advisory lookups | comes with macOS |
| core | mise | required | manual | Installs and pins every tool below; `steward sc` wraps it. The standalone build in ~/.local/bin; `steward sc upgrade-tool mise` updates it (D38) | `curl https://mise.run \| sh` |
| core | node | required | mise | lib/*.js, drift, onboarding, review, doctor and the tests | `mise install node` |
| core | yq | required | mise | Reads steward.toml and the policy files (`yq -p toml`) | `mise install yq` |
| supply-chain | Homebrew | required | manual | `steward sc audit` and `steward sc upgrade` manage formulae and casks | `see https://brew.sh` |
| supply-chain | npm | required | mise | Installs the npm -g hybrids (Ruflo, AgentDB) with a reviewed script allow-list | `mise install npm` |
| supply-chain | shasum | required | system | `steward sc node-patch` checks the Node tarball against SHASUMS256 | comes with macOS |
| supply-chain | security | required | system | `steward sc audit` reads the macOS system roots and admin trust settings | comes with macOS |
| supply-chain | softwareupdate | required | system | `steward sc audit` lists pending macOS updates | comes with macOS |
| supply-chain | mas | optional | brew | `steward sc audit` checks the App Store; skipped with a warning when missing | `brew install mas` |
| supply-chain | Docker | optional | manual | `steward sc audit` checks running images and IOC digests; skipped when Docker is not running | `install Docker Desktop` |
| fleet | gh | required | mise | Every PR, review, issue and alert read; `steward review` and `steward fleet prune-merged` | `mise install gh` |
| fleet | gh login | required | manual | GitHub is the source of record for alerts and updates; the weekly review and prune-merged need a logged-in gh | `gh auth login` |
| fleet | jq | required | brew | The pr-consolidation scripts (lock-age, pr-status, merge-and-close …) parse gh and registry JSON | `brew install jq` |
| dev | just | optional | mise | Developer tasks only: `just test`, `lint`, `docs`, `links`, `release-worktree`. The steward itself runs as `steward` | `mise install just` |
| dev | shellcheck | optional | mise | `just lint` and the lock-age script check | `mise install shellcheck` |
| dev | markdownlint-cli2 | optional | mise | `just docs` Markdown lint | `mise install npm:markdownlint-cli2` |
| dev | lychee | optional | mise | `just docs` and `just links` link checks | `mise install lychee` |
| dev | renovate | optional | mise | Checking a renovate.json with `renovate --platform=local` | `mise install npm:renovate` |
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
- **`jq`** comes from Homebrew today, not mise. Moving it into `mise/config.toml` would put it under the same pin and
  release-age gate as the rest. That is a separate decision.
