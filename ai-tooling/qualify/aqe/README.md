# AQE qualification

Proves a new AQE release safe for the shared, patched runtime before any project uses it. This is the AQE recipe in
[`skills/ai-tooling/qualification.md`](../../../skills/ai-tooling/qualification.md#aqe-the-shared-patched-runtime),
adopted on 2026-10-26 from the 2026-10-21 lane that qualified 3.15.10 (`continuation-29-aqe`). The scripts were
read line by line, and their paths now come from `steward.toml` and `ai-tooling.toml`.

```sh
ai-tooling/qualify/aqe/run.sh 3.15.12 build     # then smoke, g1, g2, g3g4, g5, g6, g7, g8, receipt
```

Everything happens in a workspace, `[paths] cache/qualify/aqe-<version>-local.1`:

- each process gets a sandbox `HOME` and an environment built from scratch;
- the web proxy is `127.0.0.1:9`, where nothing listens, so any network attempt fails at once;
- `HF_HUB_OFFLINE=1`, and workers are off unless a gate says otherwise.

Nothing is installed, and no real store is opened. The receipt and evidence are copied to
`[paths] state/qualify/aqe-<version>-local.1/`. Promotion is a separate step that needs the owner's yes: back up
every store, copy the stage into the runtime's `releases/`, then switch `current`.

| Step | What it proves |
| --- | --- |
| build | The tag rebuilt unpatched is byte-identical to the official tarball, and `patches/` apply. After patching, the statement diff against the official package shows only the patches. The stage installs with the current release's `package.json`, `bin/`, `runtime/` and `models/`, with natives compiled here. Every newly resolved package is past the release-age gate, and the installed dist matches the packed tarball. |
| smoke | The staged CLI reports the version. The MCP server starts and lists its tools. |
| G1 | The 9-test learning regression (#1055) passes twice on a seeded synthetic store. The public pattern tools return only the active pattern. |
| G2 | The offline embedding model runs with 0 network fetches, in 2 projects with independent processes, under one identity. |
| G3 | An independent process reads a stored marker back by key and by meaning. |
| G4 | Two projects never see each other's markers. |
| G5 | Rollback works. The staged and current runtimes take turns reading and writing a store the current one created. Values stay unchanged, and no table loses rows. |
| G6 | The dream guard refuses a dream and keeps a concurrent write. With the guard lifted, a write made mid-dream survives. |
| G7 | Hooks from a linked worktree, through transport v2 and the older shim, reach the stage and bind the worktree. |
| G8 | With `AQE_WORKERS_ENABLED=false`, no background workers start. A control run shows they would. |

`promote.sh` backs up the stores of the registry's AQE projects. Worktrees inherit their parent's tools (D15) and
keep their own stores, so the next round should include them (`P.effective()`).

The patches (`patches/`) are dropped when upstream supersedes them:

- `bootstrap-provenance-guard`: watch agentic-qe#1188;
- `dream-opt-out`: keeps the dream engine off in the shared runtime.
