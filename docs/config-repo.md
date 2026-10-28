# Keep your config in a private Git repo

![Revision 2](https://img.shields.io/badge/Revision-2-green) ![Revised 2026-10-28](https://img.shields.io/badge/Revised-2026--10--28-green)

Your config (the *instance*: `steward.toml`, your policy files, the registry of your projects and your mise toolchain)
is the one part of the steward that's yours alone. Putting it in a private Git repo gives you four things:

- **A history.** Every policy change, upgrade pin and project decision is a commit you can read, review and revert.
- **Renovate.** It watches your mise toolchain and proposes updates as pull requests, under the same 3-day gate.
- **A second Mac in minutes.** Clone it, link it, and the machine follows the same policy.
- **A backup.** A lost or wiped laptop costs you nothing you can't clone back.

![Making the config a repo, using it on a second Mac, and syncing a change between them](assets/steward-config-repo.svg)

> [!CAUTION]
> Keep the repo **private**. Your config names your projects, their folders and your remotes, and its registry records
> every decision you made about them.

## Contents

- [1. Make your config a repo](#1-make-your-config-a-repo)
- [2. Let Renovate keep it current](#2-let-renovate-keep-it-current)
- [3. Use it on another Mac](#3-use-it-on-another-mac)
- [4. Day to day](#4-day-to-day)
- [What the steward tells you](#what-the-steward-tells-you)
- [Keep the repo somewhere else](#keep-the-repo-somewhere-else)

## 1. Make your config a repo

`steward init` created your config in `~/.config/workstation-steward` (9 files). Commit it, then create a private
repository for it and push, in one step with the [GitHub CLI](https://cli.github.com):

```sh
cd ~/.config/workstation-steward
git init -b main && git add -A && git commit -m 'My steward config'
gh repo create <you>/steward-config --private --source . --remote origin --push
```

The steward's own state (receipts and backups in `~/.local/state/workstation-steward/`) lives outside the config, so
nothing about a particular run ends up in the repo.

## 2. Let Renovate keep it current

The `renovate.json` that `steward init` wrote tells Renovate to watch your mise toolchain (`mise/config.toml`), wait
3 days before proposing a release, and propose security fixes at once.

1. Install the [Renovate app](https://github.com/apps/renovate) (by Mend) on your account, or open its settings
   (GitHub → Settings → Applications → Renovate → Configure).
2. Under *Repository access*, add your config repo.

Renovate then proposes each update as a pull request. Merge it on GitHub, then bring each Mac level
([step 4](#4-day-to-day)).

> [!NOTE]
> If you change the gate with `steward sc release-age <days>`, it updates `steward.toml`, mise's copy and this
> `renovate.json` together; commit all three.

## 3. Use it on another Mac

Install the steward there ([Quick start](../README.md#quick-start)), then clone your config into the folder the
steward reads, and point mise at it:

```sh
git clone https://github.com/<you>/steward-config ~/.config/workstation-steward
steward check        # the config's format, and the add-ons it turns on
steward sc link      # ~/.config/mise/config.toml and mise.lock now link to the config's mise/
mise install         # the toolchain the config pins
```

`steward sc link` keeps any mise config the machine already had as `config.toml.pre-link` beside the link.

## 4. Day to day

Some steward commands change files in your config, and so do your own edits. After either, commit and push:

| Changes | Files |
| --- | --- |
| `steward sc upgrade`, `upgrade-tool`, `node-patch` | `mise/config.toml`, `mise/mise.lock` |
| `steward sc release-age <days>` | `steward.toml`, `mise/config.toml`, `renovate.json` |
| `steward projects decide` | `projects/registry.toml` |
| Your own edits | `steward.toml`, `supply-chain/host.toml`, `supply-chain/hybrids.toml`, `ai-tooling/ai-tooling.toml` |

```sh
git -C ~/.config/workstation-steward status --short
git -C ~/.config/workstation-steward commit -am '<what changed>' && git -C ~/.config/workstation-steward push
```

On your other Macs, and after merging a Renovate pull request, bring the config level and install what changed:

```sh
git -C ~/.config/workstation-steward pull --ff-only
mise install
```

> [!TIP]
> Run `steward check` after a pull: it says when the config is in a format your installed steward doesn't read yet,
> which means that Mac needs the newer steward first.

## What the steward tells you

Once your config is a Git repo, the steward keeps an eye on it for you (D50), read-only:

- **The banner.** `steward` on its own adds a `config` line when files changed here, commits aren't pushed, or GitHub
  has newer commits. It never touches the network: "newer on GitHub" is as of the last fetch, and says when that was.
- **`steward config`** ends with a `repo` section: the GitHub repository and branch, then each thing that needs you,
  with the git command that acts on it.
- **`steward review`** fetches first, then lists the same items, your config repo's open pull requests (Renovate's
  among them), and its issues labelled `owner-decision`.

![steward: a config banner line; steward config: the repo section with a changed lockfile and a newer commit, each with its git command; steward review: the same, plus a Renovate pull request](assets/steward-config-sync.svg)

Only a folder that is a Git repository of its own counts. A config inside another repository (the `examples/` folder
of a steward clone, say) gets no banner.

## Keep the repo somewhere else

If you'd rather keep the clone with your other projects, the steward follows either of these:

- **A link:** clone it where you like, then `ln -s <your clone> ~/.config/workstation-steward`.
- **A variable:** set `STEWARD_INSTANCE=<your clone>` in your shell profile.

`steward config` shows which folder the steward is using, and why.
