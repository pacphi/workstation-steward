# GitHub Actions and Docker

Evidence: claude-code-agent-manager#56, #58; draupnir#17; a private Rust CLI; a private JavaScript archiver;
a private TypeScript site; emailibrium#308; finima#170; a private Rust + Svelte app; audioshake-cli#15;
rust-optimizer#10; tanzu-genai-showcase#221; agentic-incubator/ruflo-local#34;
a client JVM + Next.js app.

## CI gates to find

- Which workflows exist (`.github/workflows/*`) versus which checks appear on the PR. A workflow
  that GitHub **disabled for inactivity** produces no check at all, so it looks like nothing is
  wrong: claude-code-agent-manager's Security Scan (#56), audioshake-cli's Check Links (#15) and
  rust-optimizer's Link Check (#10).

  ```bash
  gh workflow list -R <repo> --all          # state: disabled_inactivity
  gh workflow enable <id-or-name> -R <repo> # owner decision; then close/reopen the PR or push
  ```

  Enabling alone doesn't trigger a run; it needs a new `pull_request` event (AGENTS.md).
- Workflows that run only on `schedule` or `workflow_dispatch` (a Rust + Svelte app's `ci-deps`) never run on the
  PR; dispatch them on the branch: `gh workflow run <wf> -R <repo> --ref <branch>` (a private Rust + Svelte app).
- Release workflows (`on: push: tags`) can't run on a PR; validate them statically:
  `actionlint`, a diff of the action's `action.yml` inputs, and a local build
  (claude-code-agent-manager#58).
- `dependency-review-action` needs GitHub Advanced Security on private repos; a private TypeScript site
  gated it with `if: ... && !github.event.repository.private` instead of deleting it.

## Audit

No dedicated audit for actions in the fleet. For images, Trivy ran in a TypeScript + Postgres app's build job.
Check action advisories with `gh api '/advisories?ecosystem=actions&affects=<owner>/<action>'`
(tanzu#221: GHSA-cxww-7g56-2vh6 affects only download-artifact < 4.1.3).

## Bumps

- **Pin actions by full commit SHA with the tag in a comment:**
  `taiki-e/install-action@8cca0918f8471c33515202b73f56ab27f2bed283 # v2.87.29` (a private Rust CLI).
  Verify each SHA against its tag when you change it (a private TypeScript site):
  `gh api repos/<owner>/<action>/git/ref/tags/<tag> --jq .object.sha` (dereference annotated tags).
- Move every reference to the same action together; emailibrium had one `taiki-e/install-action`
  step left on v2.85.5 against its own "must match rust-build" comment (emailibrium#308).
- **An action major is usually a Node runtime change.** action-gh-release v3 changed only
  `using: node20` → `node24`; upload-artifact v7 moved to ESM and added an opt-in `archive` input;
  cache v5, download-artifact v7 and upload-artifact v6 are Node 24 runtime changes that need
  runner >= 2.327.1 (claude-code-agent-manager#58, tanzu-genai-showcase#221). checkout v7 also
  blocks fork-PR checkout under `pull_request_target`/`workflow_run` (draupnir#17). Diff the
  `action.yml` to see the real change; they are still majors, so defer them by default.
- A dead major line: codecov-action v6.0.2 is "a copy of v7.0.0" and the `v6` tag points at v7.0.0,
  so v5 → v7 was the honest bump (claude-code-agent-manager#58).
- Workflow edits conflict with other open PRs that edit the same files. tanzu#221 left action
  majors out to avoid conflicts with #219; a private JavaScript archiver checked with `git merge-tree` that it
  touched different lines from #122.

## Docker images

- **Pin `tag@sha256:<digest>`, never `:latest`.** Tags can be re-pushed: LiteLLM's tags were
  re-pushed with a credential stealer on 2026-10-21; Paketo's builder `latest` was re-pushed
  arm64-only on 2026-10-23. Take the multi-arch index digest:
  `docker buildx imagetools inspect <image>:<tag>` (ruflo-local#34, a client JVM + Next.js app).
- Let Renovate maintain digests: extend `docker:pinDigests` in `renovate.json`; the 3-day
  `minimumReleaseAge` then applies to image updates too (ruflo-local#34).
- A floating version tag can be re-pushed with the same contents; judge age by the release it
  carries (finima#170: `rust:1.99-bookworm` re-pushed 2026-10-22, Rust 1.99.1 released 2026-10-15).
- Some vendors publish only `latest` (Chainguard's free tier); claude-code-agent-manager#56 left
  that as an owner decision rather than invent a tag.
- Docker images that CI doesn't build need a local build to verify (a private Rust + Svelte app:
  `docker build --target runtime`).

## Publish dates

```bash
gh api repos/<owner>/<action>/releases/tags/<tag> --jq .published_at          # actions
curl -s https://hub.docker.com/v2/repositories/<ns>/<repo>/tags/<tag> \
  | jq -r '.last_updated, ([.images[].architecture] | join(","))'             # Docker Hub
```

Docker Hub's `last_updated` changes on every re-push, so it dates the push, not the release.
The same call shows the architectures: Paketo `latest` reported only `arm64`, while `0.0.197`
reported `amd64,arm64` (a client JVM + Next.js app, re-checked 2026-10-23). For upstream releases use the
project's release page (ruflo-local#34 dated each tag by its upstream release).
