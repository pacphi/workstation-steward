# Fleet

The GitHub side of the repos under `~/Development`: their Renovate configuration, and folding the security
and dependency PRs that pile up into one verified PR per repo. Changes to repos happen through pull requests
from scratch clones, never by editing checkouts under `~/Development/active`. The rules are in
[`../AGENTS.md`](../AGENTS.md) (Renovate, Repos under ~/Development, Repos with long-lived version lines).

| Path | What it is |
| --- | --- |
| [`../docs/fleet/runbook.md`](../docs/fleet/runbook.md) | Procedures: bringing a repo under Renovate, consolidating bot PRs, merging, long-lived lines |
| [`bin/`](../docs/fleet/runbook.md#after-merging) | `steward fleet sync <repo>` and `steward fleet prune-merged <repo>`: bring a checkout level with its upstream and delete merged local branches, each with a plan, the owner's yes, a backup or record, and a receipt (D34) |
| [`../skills/pr-consolidation/`](../skills/pr-consolidation/README.md) | The `pr-consolidation` skill (v2): one PR per repo that supersedes its open Dependabot and/or Renovate PRs, in any ecosystem, with every CI audit gate green. Not installed by default; its README has install instructions. |
