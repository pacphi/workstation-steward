# Release classes: what may skip the release-age gate

![Revision 2](https://img.shields.io/badge/Revision-2-green) ![Revised 2026-10-29](https://img.shields.io/badge/Revised-2026--10--29-green)

> [!NOTE]
> **Built (D52)**, except the weekly upstream watch and the maintainer runbook (*planned*, the next PR). The code is
> `lib/updaters.js`; the schema by example is in `examples/supply-chain/host.toml`.

The steward holds every new release for the release-age gate (`[policy] min_release_age_days`, 3 days by default) and
keeps old installs for the soak after a change. Two exceptions exist today, each a special case: `always_current`
(browsers, never held) and `security_exception` (one version, one advisory, an expiry). A third kind of update doesn't
fit either: **signed data that its publisher replaces daily**, such as a knowledge base or a signature database.
Brain's knowledge base is the first: a new corpus is published about once a day, its updater installs only the newest,
so a 3-day gate can never be met.

This page makes the exceptions one rule: every update source has exactly one **release class**, and the class says
whether it waits for the gate. Updates the steward doesn't install itself (a data bundle with its own updater) are
**declared** in your config, so the engine stays free of tool-specific commands.

## Two clocks, kept apart

| Clock | What it protects | Which classes |
| --- | --- | --- |
| **Release-age gate** | You don't take a release in its first days, when a bad or malicious publish is most often caught | `gated` waits; the other three may not |
| **Soak** | You can still roll back: old installs aren't pruned until a change has run for `soak_days` | every class but `signed_data`, whose own data copies are kept for `soak_days` instead (Decided, below). A skip of the gate never skips the backup or the receipt |

## The classes

| Class | Gate | What it needs | Today's equivalent |
| --- | --- | --- | --- |
| `gated` (the default) | waits | nothing | everything not listed below |
| `always_current` | none | a reason (security fixes ship in nearly every release) | `always_current = […]` in `host.toml` |
| `signed_data` | none | **all of:** signed by a key the updater pins, content-addressed, checked against the installed runtime before it lands, and backed up first. The runtime that reads the data stays `gated` | new |
| `exception` | none until it expires | an advisory (GHSA, RustSec or OSV) or a written reason, and an expiry date | `[[security_exception]]` |

A declared source has no release date the steward can read, so a `gated` `[[updater]]` that's behind is never applied
by `steward sc upgrade`: the plan holds it, and you apply it yourself after review. An `exception` past its `expires`
is `gated` again.

`signed_data` is deliberately narrow. Code never qualifies, however it is signed: a signature proves who published it,
not that the release is good, and the gate is what catches a bad release. Data qualifies because the runtime that reads
it is gated, and because the updater refuses data that runtime can't read.

## Declaring an update source

A source the steward doesn't install itself is an `[[updater]]`. The steward runs its commands; it doesn't know what
the tool is. **Known sources ship in the engine's `supply-chain/host-defaults.toml`**, the shared defaults every machine
gets (like the IOCs and distrusted roots there), so a new user who installs Brain gets its knowledge base kept current
with no setup. Your own `supply-chain/host.toml` can add sources, replace a default by its `name`, or turn one off.

```toml
[[updater]]                            # in the engine's host-defaults.toml
name = "brain-kb"
class = "signed_data"
when = "~/.cache/ruvnet-brain/kb/forge-update.mjs"                   # active only where this exists
why = "Brain's corpus: Ed25519-signed, content-addressed (corpus-sha256-<hash>), checked against the pinned runtime"
check = "node ~/.cache/ruvnet-brain/kb/forge-update.mjs --check"     # exit 0 = up to date, 10 = behind
apply = "node ~/.cache/ruvnet-brain/kb/forge-update.mjs --apply"
require_output = "source: live release asset"                        # refuse a fallback to a moving branch
backup = ["~/.cache/ruvnet-brain/kb"]                                # the steward copies it first (about 1.4 GB)
self_update_off = { file = "~/.cache/ruvnet-brain/.auto-update-pref", value = "no" }

[updater.pin]   # the signing key the updater checks bundles with, as reviewed: the text `match` finds must hash to sha256
file = "~/.cache/ruvnet-brain/kb/forge-update.mjs"
match = "-----BEGIN PUBLIC KEY-----[\\s\\S]*?-----END PUBLIC KEY-----"
sha256 = "ee12cea9da10accad46fe3a562fb392a54870576347ee99d87425d428709f103"
watch = "https://raw.githubusercontent.com/stuinfla/ruvnet-brain/main/kb/forge-update.mjs"   # the maintainer's watch
```

- **`check`** is read-only and answers by its exit status: 0 = current, 10 = behind, anything else = it couldn't
  tell (offline, say), which is reported, never taken as behind.
- **`steward sc audit`** runs each `check` (read-only) and reports a source that's behind, with its class.
- **`steward sc plan`** lists what `upgrade` would run and why each is allowed: "signed_data: skips the gate".
- **`steward sc upgrade`** asks, checks the pin, copies the `backup` paths, runs `apply`, refuses unless
  `require_output` appears, checks the pin again, and writes a receipt: what `check` printed before and after (the
  identities), the class, and the end of the command's output.
- **`pin`** is checked before `apply` (the key that checks this update is the one you reviewed) and after it (the update
  didn't bring a different key). Brain's corpus bundle replaces its own updater, key included, so without the pin a
  signed update could rotate the key unnoticed. After a change the steward puts its copy back and stops; a key
  rotation is reviewed, and `sha256` updated, in a config-repo PR.
- **`when`** names a path that must exist. A default for a tool you don't have is inactive and silent.
- **Merging**, as for the other defaults: an `[[updater]]` in your `host.toml` with a default's `name` replaces it, and
  `[off] updater = ["brain-kb"]` turns it off. A shipped key `pin` is reviewed in the engine PR that adds or changes it,
  and a key rotation reaches you in an age-gated engine release.
- **`self_update_off`** is checked by the audit like any keep-off setting, so the tool's own updater can't take
  releases behind the steward's back.
- **`backup`** lists the paths the steward copies before `apply`. It can't be left to the updater: Brain's makes
  rollback copies for the length of one run and deletes them when it succeeds. `steward sc rollback <receipt>` puts
  the copy back. Copies older than the soak are removed by `steward sc prune`, so a daily source keeps a few, not
  dozens.

## Keeping shipped defaults current

A shipped pin is only as good as the maintainer's notice of a change upstream. Four layers:

| Layer | What it catches | When |
| --- | --- | --- |
| A schema test (`test/host-defaults.test.js`) | a shipped `[[updater]]` missing `why`, `when`, `require_output` or `backup`, a `signed_data` one without a `pin`, an unknown class | every engine PR |
| An upstream watch (a scheduled GitHub workflow in the engine repo, read-only) | each shipped `pin` with a `watch` URL: fetch it, apply `match`, compare the hash; on a change it opens or updates an issue labelled `owner-decision` | weekly |
| Field reports | `steward sc audit` on any machine: a pin mismatch says the key changed and the engine's default may be behind | whenever it runs |
| A maintainer runbook (`docs/maintainers.md`) | confirm the change from the publisher's own release notes or announcement, update the pin in a PR, release; the gate then delays it like any engine change | when either of the two above fires |

## Brain, as the first case

| Part | Class | How it updates |
| --- | --- | --- |
| `ruvnet-brain` CLI (`npm:ruvnet-brain` in mise) | `gated` | a mise pin, through Renovate (an `ai-tooling` PR when ticked) |
| Brain's runtime (plugin and hooks in `~/.cache/ruvnet-brain`) | `gated` | the pinned CLI's installer, for a `v…` release past the gate |
| Brain's knowledge base (`kb/`) | `signed_data` | the `[[updater]]` above, through `steward sc upgrade` |

## Compatibility

`always_current = […]` and `[[security_exception]]` keep working as they are: the engine reads them as the
`always_current` and `exception` classes. The `[[updater]]` table is new; an older engine ignores it (an unknown
table), so it can't skip a gate it doesn't know about.

## Decided

- **A `signed_data` update doesn't restart the soak** (the owner, 2026-10-29). It writes its receipt and keeps the
  steward's copy of the old data; copies older than `soak_days` are pruned. Restarting it would keep the soak running
  for good with a daily source, and old tool installs would never be pruned. Rolling the data back still works for
  `soak_days`.

- **The evidence is kept in the `[[updater]]` entry, and the key is pinned** (the owner, 2026-10-29). `why` records
  what was reviewed, `require_output` refuses a fallback to a moving branch, and `pin` holds the signing key's hash.
  All three change only through a config-repo PR. The steward can't check a tool's signature itself; the pin makes
  sure the code that does is still using the key you reviewed.

- **Known sources ship as engine defaults, active only where the tool is installed** (the owner, 2026-10-29). New users
  get them without setup; `[off]` turns one off; the maintainer reviews each shipped key pin in an engine PR, the way
  IOCs and distrusted roots are reviewed today.

- **The maintainer keeps shipped defaults current with four layers** (the owner, 2026-10-29): a schema test, a weekly
  read-only upstream watch that opens an issue, field reports from the audit, and a maintainer runbook. The watch is
  the engine repo's first scheduled job; it only reads and opens issues.

## Docs that change when it's built

The schema is documented with the code, never ahead of it. The implementation PR updated each of these; the last
three come with the watch:

| Doc | What it gains |
| --- | --- |
| `examples/supply-chain/host.toml` | the schema by example: a commented `[[updater]]` with every field, replacing or turning off a default, and the classes in its header |
| `supply-chain/host-defaults.toml` | the `brain-kb` `[[updater]]`, and in its header how `[[updater]]` merges (by `name`, `[off]`) |
| `supply-chain/README.md` | the host-policy row, and a short "What may skip the gate" section |
| `skills/supply-chain/runbook.md` | "A declared source is behind", and "Adding an `[[updater]]`" (the evidence `why` records) |
| `AGENTS.md`, Release age | the `signed_data` class beside the advisory exception |
| `docs/lifecycle.md` | the promise, marked *planned* until it's built |
| `skills/ai-tooling/runbook.md`, Brain | the knowledge base as a declared `signed_data` source |
| `docs/maintainers.md` | "A shipped default changed upstream": the runbook above |
| `.github/workflows/` | the weekly, read-only upstream watch |
| `docs/assets/terminal/steward-supply-chain.json` | an updater line in `steward sc plan`, with the class |

## Rejected

- **Tool-specific commands** (a `steward ai brain-update`): each new data source would need engine code.
- **Gating the data anyway**: a daily source whose updater takes only the newest would never qualify.
- **A one-off exception per update**: daily approvals for the same, unchanged kind of risk.
