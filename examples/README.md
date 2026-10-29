# Example instance

![Revision 1](https://img.shields.io/badge/Revision-1-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

A starting point for your own instance: `steward.toml` (where things are) and the policy files the steward reads
(D39 in [`../docs/architecture.md`](../docs/architecture.md)). The CI tests run against this folder, so it stays
complete and valid.

| File | What it decides |
| --- | --- |
| `steward.toml` | Project roots, paths, the release-age gate and soak, which optional areas are on |
| `mise/config.toml` | Your global toolchain; `steward sc link` points `~/.config/mise/` here. Below the active tools, a curated collection to uncomment, with what each needed to install cleanly |
| `renovate.json` | How Renovate proposes toolchain updates, with the same 3-day gate: the rules of the preset `renovate/steward.json`, which you'll extend at a release tag once there is one |
| `supply-chain/host.toml` | Your additions to the engine's shared defaults (browsers that are never held, apps with a bundled Node, distrusted roots, indicators of compromise), `[off]` for defaults you don't want, and your security exceptions; `steward sc host` shows the merged result |
| `supply-chain/hybrids.toml` | CLIs installed with `npm -g`, each with its reviewed install scripts (empty to start) |
| `supply-chain/verify.tsv` | The commands `steward sc verify` checks after every change |
| `ai-tooling/ai-tooling.toml` | Policy for the optional AI tooling area (Ruflo, AQE, Brain); read only when it's on |
| `projects/registry.toml` | Your decision for each project under the roots (empty to start) |

## Start your own

```sh
mkdir -p ~/.config/workstation-steward
cp -R examples/. ~/.config/workstation-steward/
steward config            # shows: instance ~/.config/workstation-steward [~/.config default]
steward doctor            # what the machine still needs
steward sc audit          # read-only: what needs updating, and why
```

Keep the copy in a Git repo of your own, private if it names your projects, so every policy change is reviewed
and can be rolled back. To keep it somewhere else, point `$STEWARD_INSTANCE` at it.

The `host.toml` entries are real: the LiteLLM 1.107.0 and Plex2Shell indicators of compromise and the emSign ECC
Root CA - G3 distrust (October 2026), each with its source. Keep them, and add your own as advisories land.
