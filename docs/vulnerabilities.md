# Known vulnerabilities

![Revision 1](https://img.shields.io/badge/Revision-1-green) ![Revised 2026-11-02](https://img.shields.io/badge/Revised-2026--11--02-green)

Ask "is anything I have vulnerable?" and get an answer in seconds: every tool the steward installs, and the packages
inside them, checked against public advisory databases. Then fix what can be fixed with one yes, and switch off what
can't, without deleting anything. Built (D65, D66).

| You want to… | Run | It changes |
| --- | --- | --- |
| See what's vulnerable | `steward sc vulns` (also part of `steward sc audit`, `review` and `brief`) | nothing |
| Take every fix it names | `steward sc vulns-fix`, then `--apply` | after a plan and your yes; `--rollback` |
| Switch a tool off until a fix ships | `steward sc isolate <tool>`, then `--apply` | after a plan and your yes; `--undo` |

In Claude Code, ask in your own words: the supply-chain skill runs these for you (*"Is anything I have vulnerable?"*,
*"Any known CVEs in my tools?"*), and asks before anything that writes.

## What it checks

| What | How | Coverage |
| --- | --- | --- |
| mise's `npm:` tools | the tool's version, and every package in its lockfile (aube, pnpm or npm) | full |
| mise's `pipx:` tools | the tool's version, and every package in its virtual environment | full |
| mise's `cargo:` and `go:` tools | the tool's version (a Go tool by its module path) | the tool only |
| npm -g hybrids | each hybrid in the active Node, and every package in its `node_modules` | full |
| Node | a newer security release on your Node line (nodejs.org) | full |

Each package version is asked of every **feed** in `host.toml` `[[advisory_feed]]`. The engine ships three:

- **`osv`**: [api.osv.dev](https://osv.dev), which carries the GitHub Advisory Database for npm, PyPI, crates.io and Go;
- **`nodejs`**: nodejs.org's release index;
- **`kev`**: CISA's [Known Exploited Vulnerabilities](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
  catalog. It finds nothing by itself; it marks a finding whose CVE is being exploited now.

You can add your own, replace one by name, or turn one off with `[off] advisory_feed = ["kev"]`:

- **`osv-api`**: any server that speaks OSV's API, such as a mirror (`url`, and optionally `ecosystems`);
- **`osv-dir`**: a folder of OSV-format JSON records in your config folder (`path`), for an advisory no database
  carries yet. It's matched on the machine, with no network.

> [!NOTE]
> A feed is data, never code. No feed runs a program, so adding one can't run anything on your machine.

## How a finding is judged

- **Severity** is the GitHub Advisory Database's rating when there is one, else the CVSS v3 base score
  (7.0 high, 9.0 critical). A finding nobody rated counts as **high** (`unrated`).
- **An action** (on `steward review` and `steward brief`): high or critical, unrated, or known-exploited. The rest is
  listed under it.
- **A tool's own version** gets one line with the command that fixes it. **Packages inside a tool** get one line per
  tool: that tool's next release fixes them. `--verbose` lists each one.
- **Never a false "clean"**: a feed with no answer is *not checked*, and a tool no feed can read is *not covered*.
  Both are said out loud.

## What it does about a finding

```text
  rung   what                                        command
  ────   ─────────────────────────────────────────   ──────────────────────────────────────
   1     take the fixed version                      steward sc vulns-fix (exact pins past the gate,
                                                     each recorded as a security_exception)
   2     remove unused old copies that carry one     steward sc vulns-fix (before the soak ends,
                                                     those copies only)
   3     watch until a release carries the fix       steward review and steward brief keep it listed
   5     switch the tool off, keep it installed      steward sc isolate <tool>; --undo switches it on
```

Rung 4, forcing a package inside a tool to its fixed version, is deliberately left out: it can break the tool, and
it would need the sandbox testing the hybrids get.

**`steward sc vulns-fix`** plans, asks, backs up `mise/config.toml`, `mise/mise.lock` and `host.toml`, then:

1. writes a `security_exception` (the advisory, and an expiry `exception_days` away) for each pin;
2. runs `steward sc upgrade-tool <tool> <version>` for each tool, with the highest fixed version its advisories name;
3. runs `mise uninstall <tool>@<version>` for each unused install that carries a serious advisory. It refuses one a
   launcher config still points into;
4. runs `steward sc verify`, and writes a receipt.

Node is named with the command to run next, `steward sc node-patch <version>`, which reinstalls the hybrids and asks
its own yes. `--rollback <receipt>` puts the three files back (unless something changed them since) and reinstalls
what was removed.

**`steward sc isolate <tool>`** switches a tool off without removing it:

- **a mise tool** goes into `[settings] disable_tools` in your config folder's `mise/config.toml`. That's mise's own
  switch: mise ignores the tool even when a config lists it, so it holds through a reshim and `mise install`. Send it
  with `steward config sync`, like any config change;
- **an npm -g hybrid**: its command links move from the active Node's `bin` to the state folder's
  `isolated/<name>/bin`.

The reason is the tool's serious findings, or `--why "<reason>"`. `steward brief` lists what's isolated and why, and
says so if mise stops ignoring one. `--undo <tool>` switches it back on, and `--list` shows what's off.

## Exceptions

Every exception is written down: in your config (Git keeps it), in a receipt, in the output, or here.

| Exception | Where it's recorded | Why |
| --- | --- | --- |
| A finding that doesn't apply to you | `[[advisory_ignore]]` in `host.toml`: advisory, package, version, reason, expiry (all required) | The affected code is never reached. When it expires, the finding comes back. Same evidence rule as `trust_policy_excludes` |
| A fix younger than the release-age gate | `[[security_exception]]` in `host.toml`, written by vulns-fix | A serious advisory's first patched release skips the gate (AGENTS.md, Release age) |
| An unused install removed before the soak ends | the vulns-fix receipt | Only copies that carry a serious advisory; the soak still holds the rest |
| Tools AI tooling owns (Ruflo, AgentDB, AQE, Brain, RuVector…) | the output says "AI tooling owns it" | Their upgrades and any switch-off belong to the `ai-tooling` skill: its projects' launchers depend on them |
| Node and anything in `isolate_never` | refused by `isolate` | Everything depends on Node |
| Packages inside a tool | not changed (rung 4 left out) | Forcing one can break the tool |
| core, aqua, github, asdf and vfox mise tools | listed as *not covered* | They have no advisory ecosystem a feed can read |
| Homebrew, apps, the App Store, Docker images | not checked here | No reliable feed; `steward sc audit` covers their updates, Electron age and floating tags |
| Ruflo's `security cve` / `scan` | not used | It runs `npm audit` in one project, and `scan --fix` writes |

## Settings

`[vulns]` in your `host.toml` overrides any of these, key by key (the engine's
[`host-defaults.toml`](../supply-chain/host-defaults.toml) lists them too). A wrong value is reported by
`steward sc audit`, and the default is kept.

| Key | Default | What it does |
| --- | --- | --- |
| `action_severity` | `"high"` | A finding at or above this is an action: `low`, `moderate`, `high`, `critical` |
| `unrated` | `"high"` | The severity a finding nobody rated counts as |
| `exploited_always_action` | `true` | A known-exploited finding is an action whatever its severity |
| `inside_tools` | `true` | Also check the packages inside each tool and hybrid |
| `hybrids` | `true` | Check the npm -g hybrids |
| `list_not_covered` | `true` | List the tools no feed can check |
| `batch_size` | `500` | Package versions per OSV request (1–1000) |
| `parallel` | `8` | Advisory records fetched at once (1–32) |
| `timeout_seconds` | `60` | Each request to a feed (5–600) |
| `fix_skip_gate` | `"serious"` | `never`: vulns-fix doesn't pin past the gate; `steward sc upgrade` takes the fix once it clears |
| `exception_days` | `7` | How long a vulns-fix `security_exception` lasts (1–30) |
| `cleanup` | `true` | vulns-fix removes unused installs that carry serious advisories |
| `cleanup_skip_soak` | `"serious"` | `never`: that cleanup waits for the soak like `steward sc prune` |
| `isolate_suggest` | `true` | Suggest `isolate` for a known-exploited finding, or a critical one with no fix |
| `isolate_never` | `["node"]` | Tools `isolate` refuses |
| `isolate_ai_owned` | `false` | Let `isolate` switch off a tool AI tooling owns |

An example, with a feed of your own and a silenced finding, is in
[`examples/supply-chain/host.toml`](../examples/supply-chain/host.toml).
