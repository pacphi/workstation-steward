# Known vulnerabilities

![Revision 1](https://img.shields.io/badge/Revision-1-green) ![Revised 2026-11-02](https://img.shields.io/badge/Revised-2026--11--02-green)

Ask "is anything I have vulnerable?" and get an answer in seconds: the tools the steward installs, and the packages
inside them, checked against the advisory databases the security industry relies on. Then fix what can be fixed with
one yes, and switch off what can't, without deleting anything. It also tells you plainly what it could not check, and
where to look instead. Built (D65, D66).

| You want to… | Run | It changes |
| --- | --- | --- |
| See what's vulnerable, and what wasn't checked | `steward sc vulns` (also part of `steward sc audit`, `review` and `brief`) | nothing |
| Take every fix it names | `steward sc vulns-fix`, then `--apply` | after a plan and your yes; `--rollback` |
| Switch a tool off until a fix ships | `steward sc isolate <tool>`, then `--apply` | after a plan and your yes; `--undo` |

In Claude Code, ask in your own words: the supply-chain skill runs these for you (*"Is anything I have vulnerable?"*,
*"Any known CVEs in my tools?"*), and asks before anything that writes.

The session below is illustrative: the commands and output are real, from one Mac on 2 November 2026, trimmed where a
line says "more".

![steward sc vulns lists one row per tool with serious advisories (Homebrew formulae with no fixed release; gitleaks, Ruflo, gitnexus, k3d, kubectl and Node's own npm, whose packages carry advisories their next release fixes), then three coverage lines: 38 of 66 mise tools read, 68 of 92 Homebrew formulae read, and apps, the App Store, macOS updates and Docker images not covered here. steward sc vulns-fix plans removing old, unused installs that carry serious advisories, while Homebrew formulae with no fixed release wait; plan only. steward sc isolate plans switching gitnexus off with mise's disable_tools setting, keeping it installed, with the command that switches it back on](assets/steward-vulns.svg)

## What it checks

Each source says what is installed, as a [Package-URL](https://github.com/Ecma-TC54/ECMA-427/) (ECMA-427), and how
much of it it could read. On one Mac in November 2026 that was 35 of 66 mise tools and 68 of 92 Homebrew formulae:
about 3,000 package versions, in under 20 seconds.

| Source | How | Coverage |
| --- | --- | --- |
| mise's `npm:` tools | the tool's version, and every package in its lockfile (aube, pnpm or npm) | full |
| mise's `pipx:` tools | the tool's version, and every package in its virtual environment (its `.dist-info` folders) | full |
| mise's `cargo:` and `go:` tools | the tool's version (a Go tool by its module path) | the tool only |
| mise's core, aqua, github, asdf and vfox tools that are **Go programs** | the module list every Go program carries (`go version -m`), and the Go standard library it was built with | full, for Go programs; needs a `go` command |
| npm -g packages | each package in the active Node's `lib/node_modules` (the hybrids, and Node's own npm and corepack, named as Node's), and every package in its `node_modules` | full |
| Node | a newer security release on your Node line (nodejs.org) | full |
| **Homebrew formulae** | Homebrew 7's own `brew vulns`, which matches formulae against OSV.dev and knows the security patches Homebrew applies | the formulae it can match to an upstream tag; it lists the rest (`brew vulns --list-skipped`) |
| Runtimes and macOS | their release cycle against [endoflife.date](https://endoflife.date): Node, Python, Postgres, Go, Java, .NET, Rust, Ruby, PHP, Kubernetes, Terraform and more, and macOS | the products endoflife.date tracks |

Each package version is asked of every **feed** in `host.toml` `[[advisory_feed]]`. The engine ships five:

- **`osv`**: [api.osv.dev](https://osv.dev). It carries the GitHub Advisory Database for npm, PyPI, crates.io and Go,
  the Go vulnerability database, and OpenSSF's [malicious-packages](https://github.com/ossf/malicious-packages) reports
  (`MAL-` IDs) ([OSV's data sources](https://google.github.io/osv.dev/data/));
- **`nodejs`**: nodejs.org's release index;
- **`kev`**: CISA's [Known Exploited Vulnerabilities](https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
  catalog. It marks a finding whose CVE is being exploited now;
- **`epss`**: FIRST's [Exploit Prediction Scoring System](https://www.first.org/epss/), the daily chance a CVE is
  exploited in the next 30 days. It ranks the findings;
- **`endoflife`**: [endoflife.date](https://endoflife.date). A cycle past its end of life gets no security fixes at all,
  which no CVE feed can say.

You can add your own, replace one by name, or turn one off with `[off] advisory_feed = ["epss"]`:

- **`osv-api`**: any server that speaks OSV's API, such as a mirror (`url`, and optionally `ecosystems`);
- **`osv-dir`**: a folder of OSV-format JSON records in your config folder (`path`), for an advisory no database
  carries yet. It's matched on the machine, with no network.

> [!NOTE]
> A feed is data, never code. No feed runs a program, so adding one can't run anything on your machine. A source may
> run the package manager it reads (`mise ls`, `brew vulns`, `go version -m`), as the rest of the steward does.

## How a finding is judged

- **Severity** is the GitHub Advisory Database's rating when there is one, else the CVSS v3 base score
  (7.0 high, 9.0 critical). A finding nobody rated counts as **high** (`unrated`). A Homebrew finding `brew vulns`
  left unrated takes its OSV record's rating when that record has one.
- **A malicious package** (a `MAL-` record) is critical, an action, and the first thing on the list: the package
  itself is malware.
- **An action** (on `steward review` and `steward brief`): high or critical, unrated, malicious, or known-exploited.
  With `epss_action_percentile`, a likely-to-be-exploited one too. The rest is listed under it.
- **The order:** known-exploited, then malicious, then by severity, then by EPSS.
- **A tool's own version** gets one line with the command that fixes it. **Packages inside a tool** get one line per
  tool: that tool's next release fixes them. `--verbose` lists each one.
- **Never a false "clean":** a feed with no answer is *not checked*, and a tool no source can read is *not covered*.
  Both are said out loud, with the coverage of each source.

## Where to look instead

The steward checks what it can read, and names what it can't. Here is where to watch the rest.

| Not covered here | Where to look |
| --- | --- |
| Casks and other apps (Cursor, Discord, Slack…) | Each app's own updater. `steward sc audit` flags apps behind their vendor's release and apps on an Electron too old for security fixes. Browsers are never held (`always_current`) |
| The App Store and macOS | System Settings, Software Update. `steward sc audit` lists what's waiting; endoflife covers macOS's own end of life |
| Docker images | Pin each image by `tag@sha256:digest` (the audit flags floating tags). Scan images with a scanner you trust, run by you; the steward doesn't run one (see Limitations) |
| Homebrew formulae `brew vulns` skips | `brew vulns --list-skipped` names them; watch their upstream project's security page |
| mise tools that aren't Go programs (core, aqua, github, asdf, vfox) | The tool's GitHub security advisories (Watch, Custom, Security alerts), and `steward sc plan`, which takes each release after the gate |
| The projects you work on | Renovate's security PRs and each repo's audit job (`steward:pr-consolidation`) |
| An incident in the news | Ask the supply-chain skill ("is this advisory a problem here?"). It checks the primary source, then the machine. An indicator of compromise goes in `host.toml` `[[ioc]]` so every audit checks it |

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
2. runs `steward sc upgrade-tool <tool> <version>` for each tool, with the highest fixed version its advisories name.
   A fix across a major, or a 0.x minor, is listed for you instead, with that command: majors are deliberate
   (`fix_majors`). A Go program is pinned only when its module's version is the tool's own; otherwise its next
   release is the fix;
3. runs `mise uninstall <tool>@<version>` for each unused install that carries a serious advisory. It refuses one a
   launcher config still points into;
4. runs `steward sc verify`, and writes a receipt.

It names, for you to run: Node's fix (`steward sc node-patch <version>`, which reinstalls the hybrids and asks its own
yes), a Homebrew formula's fix (a `security_exception` of kind `formula`, then `steward sc upgrade`), a runtime past
its end of life (a supported release; a major is deliberate), a hybrid's fix, and anything AI tooling owns.
`--rollback <receipt>` puts the three files back (unless something changed them since) and reinstalls what was removed.

**`steward sc isolate <tool>`** switches a tool off without removing it:

- **a mise tool** goes into `[settings] disable_tools` in your config folder's `mise/config.toml`. That's mise's own
  switch: mise ignores the tool even when a config lists it, so it holds through a reshim and `mise install`. Send it
  with `steward config sync`, like any config change;
- **an npm -g hybrid**: its command links move from the active Node's `bin` to the state folder's
  `isolated/<name>/bin`. `steward sc install-hybrids` and `steward sc node-patch` put them back; `steward brief` then
  says the isolation was lost, and isolating it again moves them aside again.

It suggests itself for a malicious package, a known-exploited finding, or a critical one with no fix. The reason is
the tool's serious findings, or `--why "<reason>"`. `steward brief` lists what's isolated and why, and says so if mise
stops ignoring one. `--undo <tool>` switches it back on, and `--list` shows what's off. A Homebrew formula can't be
isolated yet.

## Limitations

- **No reachability analysis.** A finding means the vulnerable version is present, not that your use reaches the
  flaw. Go's [`govulncheck`](https://go.dev/doc/security/vuln/) can tell for Go programs; the steward doesn't run it
  (see below).
- **Unrated findings count as high.** Some databases (Go's, PyPI's, and many Homebrew matches) give no rating, so a
  run can show more actions than you expect. `unrated` and `advisory_ignore` tune it.
- **Homebrew's coverage is Homebrew's.** `brew vulns` checks installed formulae against OSV.dev and knows the patches
  Homebrew applies ([Homebrew 7.0.0](https://brew.sh/2026/09/13/homebrew-7.0.0/)); a formula it can't match is
  skipped (`--list-skipped`), and casks are not scanned (`brew vulns --help`).
- **NVD is not a source.** Since 15 April 2026 NIST enriches only CVEs in CISA's KEV catalog, in software the federal
  government uses, or in critical software; the rest are marked "Lowest Priority - not scheduled for immediate
  enrichment", and its backlog from before 1 March 2026 moved to "Not Scheduled"
  ([NIST](https://www.nist.gov/news-events/news/2026/04/nist-updates-nvd-operations-address-record-cve-growth)).
  CPE matching also guesses at product names. CVE IDs still arrive as aliases through OSV.
- **The steward runs no third-party scanner.** A scanner reads everything and is a target itself: on 19 March 2026 a
  malicious Trivy release was published and 76 of the 77 `trivy-action` tags were repointed to malicious commits
  ([GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23),
  CVE-2026-33634, added to CISA's KEV catalog on 26 March 2026). Planned instead: a CycloneDX inventory any scanner
  you choose can read.
- **EPSS and endoflife.date are best effort.** EPSS "estimates the probability that a published CVE will be exploited
  in the wild in the next 30 days" ([FIRST](https://www.first.org/epss/)): a probability, not a verdict.
  endoflife.date is a community dataset whose API "is currently in Beta, and breaking changes can happen"
  ([its README](https://github.com/endoflife-date/endoflife.date)). A feed that doesn't answer is reported as not
  checked.

## Exceptions

Every exception is written down: in your config (Git keeps it), in a receipt, in the output, or here.

| Exception | Where it's recorded | Why |
| --- | --- | --- |
| A finding that doesn't apply to you | `[[advisory_ignore]]` in `host.toml`: advisory, package, version, reason, expiry (all required) | The affected code is never reached. When it expires, the finding comes back. Same evidence rule as `trust_policy_excludes` |
| A fix across a major version | listed under *yours* in the vulns-fix plan, with its command | Majors are deliberate (AGENTS.md); `fix_majors = "take"` changes it |
| A fix younger than the release-age gate | `[[security_exception]]` in `host.toml`, written by vulns-fix | A serious advisory's first patched release skips the gate (AGENTS.md, Release age) |
| An unused install removed before the soak ends | the vulns-fix receipt | Only copies that carry a serious advisory; the soak still holds the rest |
| Tools AI tooling owns (Ruflo, AgentDB, AQE, Brain, RuVector…) | the output says "AI tooling owns it" | Their upgrades and any switch-off belong to the `ai-tooling` skill: its projects' launchers depend on them |
| Node, its own npm and corepack, and anything in `isolate_never` | refused by `isolate`; a finding in Node's npm says a Node release carries the fix | Everything depends on them, and only a Node release changes them |
| Packages inside a tool | not changed (rung 4 left out) | Forcing one can break the tool |
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
| `list_not_covered` | `true` | List the tools no source can check |
| `go_binaries` | `true` | Read the module list of Go programs among mise's core, aqua and github tools |
| `homebrew` | `true` | Run Homebrew's own `brew vulns` for its formulae (Homebrew 7 or later) |
| `eol_severity` | `"high"` | The severity of a runtime or macOS past its end of life |
| `epss_action_percentile` | `0` | 1–100: a finding at or above this EPSS percentile is an action whatever its severity; `0`: EPSS only ranks |
| `batch_size` | `500` | Package versions per OSV request (1–1000) |
| `parallel` | `8` | Requests at once (1–32) |
| `timeout_seconds` | `60` | Each request to a feed (5–600) |
| `fix_skip_gate` | `"serious"` | `never`: vulns-fix doesn't pin past the gate; `steward sc upgrade` takes the fix once it clears |
| `exception_days` | `7` | How long a vulns-fix `security_exception` lasts (1–30) |
| `fix_majors` | `"list"` | `take`: vulns-fix's one yes covers a fix across a major (or a 0.x minor) too, marked `MAJOR` in the plan |
| `cleanup` | `true` | vulns-fix removes unused installs that carry serious advisories |
| `cleanup_skip_soak` | `"serious"` | `never`: that cleanup waits for the soak like `steward sc prune` |
| `isolate_suggest` | `true` | Suggest `isolate` for a malicious package, a known-exploited finding, or a critical one with no fix |
| `isolate_never` | `["node", "npm", "corepack"]` | Tools `isolate` refuses |
| `isolate_ai_owned` | `false` | Let `isolate` switch off a tool AI tooling owns |

An example, with a feed of your own and a silenced finding, is in
[`examples/supply-chain/host.toml`](../examples/supply-chain/host.toml).

## Add a source or a feed

The design is meant to grow with help. There are three places to add to it, and each has a contract and tests that
need no network.

- **A source** ([`lib/vulnsources.js`](../lib/vulnsources.js)): reads what a package manager installed and returns
  `{ecosystem, name, version, tool, top}` for each package (a purl follows from those), plus one coverage line that
  says what it could and couldn't read. A Linux package manager whose distribution OSV covers (Debian, Ubuntu, Red Hat,
  Rocky, AlmaLinux, SUSE, openSUSE, Alpine) needs nothing more: OSV matches it. Test it with canned command output.
- **A feed** ([`lib/vulnfeeds.js`](../lib/vulnfeeds.js) and `FEED_KINDS` in [`lib/vulns.js`](../lib/vulns.js)):
  a new kind reads one data format into OSV-shaped records or annotations. It never runs a program. Test it with a
  canned answer; it must report "not checked" when the service doesn't answer.
- **An end-of-life mapping** (`PRODUCTS` in [`lib/vulnfeeds.js`](../lib/vulnfeeds.js)): one line maps a mise tool to
  its endoflife.date product.

## Planned

In order, each its own PR (also in [`lifecycle.md`](lifecycle.md#known-vulnerabilities)):

1. **OpenVEX**: your `advisory_ignore` entries written as an OpenVEX document, and vendors' VEX documents read as a
   feed, so a vendor's "not affected" counts here. Red Hat, openSUSE and Microsoft publish CSAF VEX and Chainguard
   publishes OpenVEX, though adoption "remains inconsistent and uncertain" ([OpenSSF](https://openssf.org/blog/2026/01/08/signal-in-the-noise-an-industry-wide-perspective-on-the-state-of-vex/)).
2. **CycloneDX and SARIF**: `steward sc sbom` writes the machine's inventory as a CycloneDX SBOM
   ([ECMA-424](https://ecma-international.org/publications-and-standards/standards/ecma-424/), 2nd edition, CycloneDX
   1.7) that any scanner can read, and `steward sc vulns --sarif` writes findings for code-scanning dashboards.
3. **Provenance before the gate**: vulns-fix checks that a fixed npm version carries build provenance before it pins it
   past the gate. Provenance links a package to its source and build, but "does not guarantee the package has no
   malicious code" ([npm](https://docs.npmjs.com/generating-provenance-statements)), so it adds to the gate, never
   replaces it.
4. **Each Linux source** (apt, dnf, zypper, apk first) reports its packages with the distribution's OSV ecosystem as
   it lands; pacman, portage, xbps and Nix need their own trackers.

## Sources

Each claim on this page was checked against its primary source on 2 November 2026.

| Claim | Primary source |
| --- | --- |
| OSV carries the GitHub Advisory Database, the Go and PyPI databases, RustSec and OpenSSF's malicious-packages reports | [OSV: data sources](https://google.github.io/osv.dev/data/) |
| OSV's API takes a Package-URL as well as a name and ecosystem; purl is an Ecma standard | [OSV API](https://google.github.io/osv.dev/post-v1-query/); [ECMA-427 (TC54)](https://github.com/Ecma-TC54/ECMA-427/) |
| What CISA's KEV catalog is, and that CVE-2026-33634 (Trivy) was added on 26 March 2026 | [KEV catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) and its [JSON feed](https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json) |
| What EPSS estimates, published daily | [FIRST: EPSS](https://www.first.org/epss/) |
| endoflife.date's data and its API's status | [endoflife.date README](https://github.com/endoflife-date/endoflife.date) |
| `go version -m` prints a program's embedded module information | [The go command](https://pkg.go.dev/cmd/go#hdr-Print_Go_version) |
| Homebrew 7's `brew vulns` (OSV.dev, Homebrew's own advisory database, patches, `--list-skipped`); casks not scanned | [Homebrew 7.0.0](https://brew.sh/2026/09/13/homebrew-7.0.0/); `brew vulns --help` (Homebrew 7.0.12) |
| NIST's NVD enrichment since 15 April 2026 | [NIST, 15 April 2026](https://www.nist.gov/news-events/news/2026/04/nist-updates-nvd-operations-address-record-cve-growth) |
| The Trivy compromise of March 2026 | [Aqua: GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23) |
| Provenance doesn't guarantee a package is free of malicious code | [npm: provenance](https://docs.npmjs.com/generating-provenance-statements); [SLSA threats](https://slsa.dev/spec/v1.1/threats-overview) |
| Who publishes VEX, and how far adoption has got | [OpenSSF, January 2026](https://openssf.org/blog/2026/01/08/signal-in-the-noise-an-industry-wide-perspective-on-the-state-of-vex/) |
| CycloneDX is ECMA-424, 2nd edition (CycloneDX 1.7) | [Ecma: ECMA-424](https://ecma-international.org/publications-and-standards/standards/ecma-424/) |
