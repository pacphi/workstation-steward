# workstation-steward: developer and product-lifecycle tasks only (D41). The steward's own commands are the `steward`
# client (bin/steward.js; `steward help`); this file builds, tests and checks the engine and pins the release channel.

# List the developer tasks
default:
    @just --list

# Lint every script in the repo: Biome and the TypeScript checker over the JavaScript (D45; once, for Node's type
# definitions: npm ci --ignore-scripts --prefix tools/types), shellcheck over the Bash, then syntax and config checks
lint:
    biome lint --error-on-warnings .
    tsc -p tsconfig.json
    shellcheck -x lib/lib.sh tools/release-worktree .claude/skills/steward-maintain/bin/*.sh supply-chain/bin/install-hybrids supply-chain/bin/link supply-chain/bin/mise-self-update supply-chain/bin/node-patch supply-chain/bin/prune supply-chain/bin/release-age supply-chain/bin/retire-hybrid supply-chain/bin/rollback supply-chain/bin/status supply-chain/bin/trust-review supply-chain/bin/upgrade-tool supply-chain/bin/verify
    node --check bin/steward.js
    node --check tools/export.js
    node --check tools/terminal-svg.js
    node --check tools/leak-check.js
    node --check lib/commands.js
    node --check lib/projects.js
    node --check lib/host.js
    node --check lib/pins.js
    node --check lib/config.js
    node --check lib/soak.js
    node lib/config.js --check
    node --check projects/bin/projects.js
    node --check projects/bin/profile-check.js
    node --check projects/bin/onboard.js
    node --check lib/onboard.js
    node --check lib/review.js
    node --check lib/progress.js
    node --check lib/doctor.js
    node --check projects/bin/offboard.js
    node --check lib/offboard.js
    node --check lib/profiles.js
    node --check lib/reconcile.js
    node --check projects/bin/reconcile.js
    node --check tools/known-units.js
    node --check tools/publish-guard.js
    node --check lib/platform.js
    node --check lib/providers/brew.js
    node --check lib/providers/mise.js
    node --check supply-chain/checks/index.js
    node --check supply-chain/bin/audit.js
    node --check supply-chain/bin/upgrade.js
    node --check lib/ui.js
    node --check fleet/bin/sync.js
    node --check fleet/bin/prune-merged.js
    node --check ai-tooling/transports/aqe-hook-bundle.cjs
    node lib/profiles.js --check
    node --check ai-tooling/bin/drift.js
    node --check ai-tooling/bin/repin.js
    node --check ai-tooling/bin/guard.js
    node --check ai-tooling/bin/transport.js
    node --check ai-tooling/bin/timeouts.js
    node --check ai-tooling/bin/approvals.js
    node --check lib/localedit.js
    node --check lib/hooktimeouts.js
    node --check lib/write.js
    node --check supply-chain/bin/addon-check.js
    node --check supply-chain/bin/tool-age.js
    shellcheck -x skills/pr-consolidation/scripts/lock-age.sh
    node supply-chain/bin/lock-check.js
    node --test test/onboard.test.js test/soak.test.js test/fleet.test.js

# Markdown lint (.markdownlint-cli2.jsonc) and links between docs, offline: what the Docs check runs on every PR
docs:
    markdownlint-cli2 '**/*.md'
    lychee --config lychee.toml --offline --no-progress '**/*.md'

# Every link in the Markdown, external URLs included (network; the gh login lets it read private repos)
links:
    GITHUB_TOKEN="$(gh auth token)" lychee --config lychee.toml --no-progress '**/*.md'

# Rebuild projects/profiles/known-units.json, the hashes of every unit published Ruflo, claude-flow and AQE releases
# ship (network: npm and jsDelivr, cached under ~/.cache). Run after qualifying a new release, then commit the file
known-units:
    node tools/known-units.js

# Pin the release channel to a tag, and write the steward and steward-dev launchers (D41): plans, then asks
release-worktree tag:
    tools/release-worktree {{tag}}

# Build the public engine repo's tree in an empty folder (tools/public.txt allow-list, tracked files only), then check it
export folder:
    node tools/export.js {{folder}}

# Nothing private in what goes public: config files, archive/ and owner/, home paths, the private terms in your config's
# leak-terms.txt. With no folder it checks an export of this checkout. Run before every push from the public clone
leak-check *folder:
    node tools/leak-check.js {{folder}}

# Start Claude Code with this checkout's skills loaded as the `steward` plugin (D48): /steward:supply-chain and the rest, read
# in place, ahead of any installed release. After editing a skill, /reload-plugins in the session picks it up
claude *args:
    claude --plugin-dir . {{args}}

# Rebuild the README's animated terminals (docs/assets/*.svg) from their scripts in docs/assets/terminal/
terminal-svg:
    node tools/terminal-svg.js

# Run every test: the merge rules and writers, then onboarding and offboarding end to end on throwaway repos
test:
    node --test test/
