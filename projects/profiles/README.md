# Per-tool profiles

What `steward projects onboard` gives a project for each AI tool its registry entry lists (D18, D21–D24 in
[`../../docs/architecture.md`](../../docs/architecture.md)). One file per tool:

| File | Tool | Includes |
| --- | --- | --- |
| [`ruflo.toml`](ruflo.toml) | Ruflo | RuVector (its vector layer, D21) and AgentDB (its memory backend); the full helper set (D22) |
| [`aqe.toml`](aqe.toml) | AQE | the shared runtime's MCP server, AQE's hooks through the hook transport (D24) |
| [`brain.toml`](brain.toml) | RuvNet Brain | the per-project plugin and Codex server |

## What they are, and aren't

- **Stack-neutral.** The same wiring on every stack. What differs by project (stack, monorepo root, Node, each
  file's Git state) comes from `steward projects facets`, detected in the project itself.
- **Not a copy of a project.** Values come from the qualified installs (Ruflo's and AQE's own generators,
  read from the installed versions), the migration's receipts, and `ai-tooling/ai-tooling.toml`. Each
  non-obvious value says where it comes from. `steward projects profile-check` compares every project with them
  and gives a reason for each difference.
- **Adds only.** A key or file a project already has is kept: a project's own choice wins.
- **Shared names belong to the first tool (D26).** Ruflo and AQE both ship the Claude-Flow skills, commands and
  agents; Ruflo owns them, copied unchanged. When both are chosen, AQE's copies skip every name the qualified Ruflo
  ships (`render()` computes it from the installs; `just lint` fails if two tools would copy one name). Every
  onboarded project with AQE also has Ruflo; AQE alone would copy its full set.
- **The keep-off list wins.** `[[keep_off]]` in `ai-tooling.toml` names what is never turned on or written,
  whatever a vendor defaults to (the daemon, idle auto-assign, permissions, trust grants, unpinned launchers…).
  `just lint` fails if a profile breaks it.
- **Outdated vendor files are refreshed, edited ones kept (D25).** [`known-vendor-files.toml`](known-vendor-files.toml)
  lists the sha256 of every known unedited AQE hook file; only those are replaced, unless the owner names a file.
- **Copies from before the steward are recognized when unedited (D42).** [`known-units.json`](known-units.json) lists
  the hash of every helper, skill, command, agent and hook file that published Ruflo, claude-flow and AQE releases
  ship. `steward projects reconcile` updates a copy with no receipt when its hash is listed for that path. It holds
  only public package data; `just known-units` rebuilds it from jsDelivr's per-file hashes of each npm release, after
  checking them against the installs on the machine.
- **No machine paths.** Only placeholders, filled per project by `lib/profiles.js`.

## Format

| Table | Becomes |
| --- | --- |
| `[settings]` | `.claude/settings.json` keys (merged, adds only) |
| `[settings_local]` | `.claude/settings.local.json` keys |
| `[[hook]]` | one Claude Code hook: `event`, `matcher` (optional), `command`, `timeout` in **seconds**, `continueOnError` |
| `[mcp.<name>]` | `.mcp.json` `mcpServers.<name>` |
| `[codex]` | `.codex/config.toml`: `plugins`, `mcp_servers` |
| `[codex.approve]` | `<server> = [tool, …]`: `mcp_servers.<server>.tools.<tool>.approval_mode = "approve"` (D17; `--no-approvals` omits) |
| `[codex.prompt]` | `<server> = [tool, …]`: `approval_mode = "prompt"`, so the owner confirms each run (D37); written even with `--no-approvals` |
| `[[copy]]` | a file or folder copied from a qualified install; a folder with `.LOCKED` gets missing names only |
| `[[write]]` | a small file created whole if absent (`text` or `json`) |
| `[[manual]]` | a step onboarding lists and never runs |
| `[user_off]` | nothing: what must stay off at user level for a tool switched on per project only (D55). `claude_plugins` (`~/.claude/settings.json` `enabledPlugins`), `codex_plugins` (`~/.codex/config.toml` `[plugins."…"]`) and `codex_mcp_servers` (`[mcp_servers.…]`); `steward ai drift` reports any that is on |

## Placeholders

| Placeholder | Value (from) |
| --- | --- |
| `{{PROJECT}}` | the project's folder |
| `{{HOME}}` | the home folder |
| `{{NODE}}`, `{{RUFLO}}`, `{{RUVECTOR}}` | `[launch]` in `ai-tooling.toml` (stable links, D11/D12) |
| `{{RUFLO_CLI}}` | `{{RUFLO}}/node_modules/@claude-flow/cli` |
| `{{AQE}}`, `{{AQE_PKG}}` | `[aqe] runtime` + `/current`, and its `node_modules/agentic-qe` |
| `{{AQE_HOOK_TRANSPORT}}` | `[aqe] hook_transport` |
| `{{RUFLO_CORE}}` | `[ruflo_core] runtime` + `/current` |
| `{{RUFLO_MARKETPLACE}}` | `[ruflo] marketplace` |
| `{{BRAIN_CODEX_SERVER}}` | `[brain] codex_server` |
| `{{OS}}`, `{{ARCH}}`, `{{SHELL}}` | this machine (what Ruflo's generator detects) |

The locations themselves live in `ai-tooling.toml` for now; they move to `steward.toml` with the other
machine-specific values (a recorded follow-up in `docs/architecture.md`).

## When a qualified install changes

A new Ruflo or AQE version can change what its generator writes. Qualifying it includes re-reading the
generator against these files and updating them in the same PR. `steward projects profile-check` then shows what
onboarding would add to every project, before anything is applied.
