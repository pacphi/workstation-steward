# Node (pnpm, npm)

Evidence: ampel#86, #87; claude-autopilot#34; rust-optimizer#10;
java-spring-modernization-marketplace#20 (a pnpm repo); agentic-kit#475; a private Rust + Svelte app;
emailibrium#308, #313; finima#170; a private Rust CLI; neon-drift#14; a private TypeScript + Postgres app; slappy#66;
reelbox-cli#13; a private JavaScript archiver; a private TypeScript site; a client JVM + Next.js app; tanzu-genai-showcase#221.
No yarn repo was in the fleet; yarn.lock is detected but nothing here is yarn-specific.

## CI gates to find

- Package manager and version: `packageManager` in `package.json`, which lockfile exists,
  `engines`, `.nvmrc`/`.node-version`, the Node matrix in workflows. Run the repo's pinned manager
  (`npx -y pnpm@<ver>`), and the Node versions CI uses (claude-autopilot#34 ran its gate on 26 and
  22; a private JavaScript archiver on 22, 24 and 26 plus npm 12).
- Install (`--frozen-lockfile` / `npm ci`), typecheck, lint, format check, unit tests, build,
  e2e (Playwright), and audit, in the order CI runs them. A red audit step can hide everything
  after it: neon-drift's test and build steps never ran on `main` while its audit was red
  (neon-drift#14).
- Audit flags differ per repo: `--audit-level high|moderate`, `--prod` (a private TypeScript + Postgres app audits
  prod only, so dev-only findings don't gate there), or a repo script (a JavaScript archiver's
  `scripts/check-npm-audit.mjs` audits `scripts/` and `site/` separately).

## Audit

```bash
pnpm audit --audit-level <CI level>     # pnpm repos
npm audit --audit-level <CI level>      # npm repos, per lockfile directory
gh api repos/<repo>/dependabot/alerts --jq '.[] | select(.state=="open") | .security_advisory.ghsa_id'
gh api /advisories/<GHSA-id>             # first_patched_version, ranges
```

- pnpm ignores live in `pnpm-workspace.yaml` under `auditConfig.ignoreGhsas`, with an inline
  comment per entry; pnpm 12.3.4 reports them as "(N ignored)" (slappy#66, reelbox-cli#13,
  a private TypeScript site).
- **A repo audit script can fail open.** A JavaScript archiver's script read an `npm audit --json` error body
  (registry timeout) as zero vulnerabilities and printed "ok"; fixed to exit 1 on `report.error`
  (a private JavaScript archiver). Reproduce with `npm_config_registry=http://127.0.0.1:1`.
- The npm bulk-advisory endpoint timed out fleet-wide around 02:55-03:05Z on 2026-10-22. A timeout
  is a flake to rerun, not a result (triage notes-A, notes-C).
- Match advisory aliases through the API, not by title: CVE-2026-94483 (Trivy) is
  GHSA-cjq9-62q9-8jv4 (a private TypeScript + Postgres app).

## Bumping a transitive-only package

1. **In-range refresh first.** If the parent's range already allows the fix, no override is
   needed: `pnpm update <pkg> --depth Infinity` (neon-drift#14) or
   `pnpm update brace-expansion markdown-it` (claude-autopilot#34).
2. **Override, kept inside the current major,** when the parent pins below the fix.
   - pnpm 11+ reads overrides from `pnpm-workspace.yaml` `overrides:`, **not** from the
     `package.json` `pnpm` field. A repo moved to pnpm 11 with overrides left in `package.json`
     failed `--frozen-lockfile` with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (spring-ai-resos#160,
     triage notes-D).
   - Scope it when you can: `markdownlint-cli2>markdown-it: 15.0.3` (a private TypeScript site), or a
     version-range key like `brace-expansion@>=4.0.0 <5.0.12` (a private Rust + Svelte app).
   - Use `^x.y.z`, never `>=`: a `>=` override can jump to the next major (claude-autopilot#34
     replaced `js-yaml ">=5.2.2"` with `"^5.4.1"`).
   - npm uses nested `overrides` in `package.json` (a private JavaScript archiver:
     `markdownlint-cli2 > markdown-it ^15.0.3`).
   - Every override gets an inline comment with the advisory and its exit condition, usually
     "remove when the parent releases a fixed pin" (reelbox-cli#13, a private JavaScript archiver).
3. **Remove overrides that now block fixes.** slappy's `devalue: ^5.6.2` override would have
   forced nuxt 4.6 (which needs `devalue ^6.0.2`) back across a major, and its `simple-git`
   override was dead config once `@nuxt/devtools` dropped simple-git (slappy#66).

## Release age: holding a version back

`pnpm --config.minimum-release-age=4320` (and `minimumReleaseAge: 4320` in the workspace file) is
**not reliable**: pnpm 11.0.0 still resolved `ignore@7.0.13`, 2 days 23 hours old
(rust-optimizer#10). Always verify with `scripts/lock-age.sh`. To hold one back:

1. add a temporary exact override (`vite: 8.3.4`) and resolve;
2. remove the override and resolve again;
3. confirm the lockfile's own `overrides:` block no longer lists it.

Used for vite 8.3.5 / rolldown 1.2.15 (finima#170), vite 8.3.5 (reelbox-cli#13) and ignore
(rust-optimizer#10). For npm, `npm install --before=<now minus 72h>` held `@aws-sdk/*` and
`puppeteer-core` back (a private JavaScript archiver).

## Publish dates

Two lockfiles outside Git (for example a mise `npm:` tool's `aube-lock.yaml`, same format as pnpm's): `scripts/lock-age.sh --files OLD NEW`.
`steward sc tool-age npm:<package> <version>` wraps it with a sandbox install.

```bash
curl -s https://registry.npmjs.org/<name> | jq -r '.time["<version>"]'
# scoped: https://registry.npmjs.org/@scope%2Fname
```

## Known traps

- **npm 12 (and pnpm) block dependency install scripts.** Check whether the script matters before
  allowing it: protobufjs's postinstall only prints a warning, and `npm ci`, tests and import all
  work with it blocked (a private JavaScript archiver). AGENTS.md has the allow-scripts rule.
- **A "patched" version that doesn't exist.** braces GHSA-vfj7-8cjw-p6xm: pnpm says `>=3.0.4`,
  npm's latest is 3.0.3 and the GHSA has `first_patched_version: null`; it is ignored with an exit
  condition (reelbox-cli#13, slappy#66, a private TypeScript site). smol-toml 1.8.1 was never
  published; 1.9.0 is the real first fix (claude-autopilot#34).
- **The markdownlint chain.** markdownlint-cli and -cli2 pin js-yaml, smol-toml and markdown-it
  exactly, so the fixes need overrides until a new release of the CLI; katex GHSA-238p-pmpm-9mq7
  needs 0.16 → 0.18 (a 0.x major) and was deferred as unreachable everywhere (claude-autopilot#34,
  rust-optimizer#10, a private JavaScript archiver, reelbox-cli#13).
- **Peer pins that Dependabot breaks.** Dependabot bumped zone.js to ~0.16 while `@angular/core`
  was ^17 (peer zone.js ~0.14), and typescript to 5.9 (Angular 17's compiler-cli needs `<5.5`); the
  frontend hadn't built since. The fix moved two dependencies down to match the installed
  runtime and added the missing `tsconfig.app.json` (tanzu-genai-showcase#221). Group a
  framework's toolchain packages with the framework in Renovate.
- **Next.js:** 16.3.8 was inside the 16.0.0-16.4.0 range of two RCEs published 2026-10-14
  (GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw); 16.4.2 was the newest past the 3-day gate
  (a client JVM + Next.js app). `pnpm add next@16.4.2 --save-exact` changed only `next`, `@next/env` and
  `@next/swc-*`.
- **Playwright timing.** Playwright 1.64's Chromium renders about 2x slower under SwiftShader than
  1.60's, so a HUD assertion overran its timeout; bisected in the Playwright Docker image, fixed
  with a per-assertion `{ timeout: 20_000 }` (neon-drift#14). A TypeScript site's 36-navigation
  test needed `test.setTimeout(90_000)` (a private TypeScript site).
- **axe-core 4.14** enables `label-content-name-mismatch` by default and failed a11y checks in two
  repos; held at 4.13 and reported, since the fix is markup (slappy#66, a private TypeScript site).
- **New lint rules in minors:** oxlint 1.88 `react/purity` flagged `new Date()` in server
  components; fixed with line-scoped disables plus a reason (a private TypeScript + Postgres app).
- **`@types/node` majors follow the runtime,** not the bot: keep them in the runtime's major
  (a private TypeScript + Postgres app, a private TypeScript site).
- **0.x packages that release every minor**: three r184 → r185 is a 0.x minor, so a major under
  the policy; neon-drift#14 took it after reading the migration notes. Flag such cases to the
  owner rather than take them silently.
- **Lockfile not committed** (tanzu's Angular frontend gitignores `package-lock.json`), so CI
  resolves fresh each run and the age gate can't be enforced. Report it.
- **npm 12 output changes** can break repo scripts: `npm pack --dry-run --json` returns an object,
  not an array (agentic-kit#475 report).
