# Go

Evidence: claude-code-agent-manager#56, #58; draupnir#17; tanzu-genai-showcase#221 (go-fiber
subproject); a private JavaScript archiver (slackdump install matrix).

## CI gates to find

- The Go version CI installs. `actions/setup-go` with `go-version-file: go.mod` installs exactly
  the `go` directive, so a `go 1.25.0` line means binaries are built with 1.25.0 and its stdlib
  vulnerabilities (draupnir#17).
- `golangci-lint`, `deadcode`, `govulncheck`, `nancy`, `go vet`, `gofmt -s -l`, `go test -race`,
  cross-compiles, and `make` targets that CI calls.
- Every tool installed with `@latest` or `version: latest`. Those are pre-existing failures
  waiting to happen (below).

## Audit

```bash
go install golang.org/x/vuln/cmd/govulncheck@<pinned>   # v1.9.0 in the fleet
govulncheck ./...                                        # exits non-zero only for CALLED vulns
gh api repos/<repo>/dependabot/alerts                    # module-level alerts
```

- govulncheck separates **called** vulnerabilities (fail) from module-level ones whose code isn't
  imported (reported, don't fail). claude-code-agent-manager went from 49 called to 0; the
  module-level GO-2026-5932 (deprecated x/crypto/openpgp, no fix) stays and doesn't fail (#56).
- Many called findings are in the **standard library**, so the fix is the `go`/`toolchain`
  directive, not a module bump: go1.26.9 / go1.26.10 fixed the called stdlib vulns in
  claude-code-agent-manager#56; draupnir#17 cleared 24 of 34 by moving 1.25.0 → 1.25.14 (the
  last 1.25 patch) and left 10 that only Go 1.26 fixes as an owner decision. tanzu#221 left Go
  1.24.4 with 38 called stdlib vulns, also a decision. A language minor (1.24 → 1.26) is a
  deliberate change: report it.

## Bumping a dependency

```bash
go get <module>@<version> && go mod tidy     # no -u: -u also upgrades everything else
```

`go get chromedp@v0.21.0 && go mod tidy` without `-u` kept cdproto v0.158.x, only 2 days old, out
of the graph (claude-code-agent-manager#58). `go get` can also move other modules (moving purego
in draupnir also moved gopsutil, seen while testing `lock-fix.sh`), so run `scripts/lock-age.sh` after.
`scripts/lock-fix.sh` handles a one-module security bump.

- Newer module releases can raise the `go` directive: gopsutil 4.26.9 declares `go 1.26.0`, so
  draupnir#17 stopped at 4.26.8; tanzu#221 capped klauspost/compress and fasthttp at the newest
  release with `go <= 1.24`.
- `golang.org/x/*` versions by minor (x/sys 0.41 → 0.47): the owner's 0.x rule exempts it
  (AGENTS.md; draupnir#17 flagged it).

## Publish dates

```bash
curl -s https://proxy.golang.org/<module>/@v/<version>.info | jq -r .Time
# module paths with capitals are case-encoded: github.com/BurntSushi -> github.com/!burnt!sushi
curl -s https://proxy.golang.org/golang.org/toolchain/@v/v0.0.1-go<1.26.10>.linux-amd64.info | jq -r .Time
```

The toolchain lookup returns 2026-10-19T22:20:36Z for go1.26.10, the date claude-code-agent-manager#56
used for its first-patched exception (GO-2026-6809).

## Known traps

- **`@latest` CI tools broke CI:**
  - `golangci-lint` `version: latest` moved to v2.15.0 and new gosec G703 and prealloc findings
    went red; pinned to v2.15.0 and the findings fixed in code, with no `nolint`
    (claude-code-agent-manager#56). draupnir#17 pinned the same version before it broke.
  - `govulncheck-action` installs `govulncheck@latest`, which needs Go >= 1.25; replaced with a
    pinned `go install ...@v1.9.0` (claude-code-agent-manager#56).
  - `deadcode@latest` pulls x/tools needing Go 1.26; pinned to `deadcode@v0.49.0`, the last with a
    1.25 floor, with a comment to move it with the Go version (draupnir#17).
  - Install hints in docs used the v1 golangci-lint module path, which can't read a v2 config
    (draupnir#17).
- **Dependency Review license for golang.org/x:** GitHub reports x/net and x/sys as
  `BSD-3-Clause AND LicenseRef-scancode-google-patent-license-golang` (Go's PATENTS grant), which
  fails a strict license allowlist. Allowlist those purls in `allow-dependencies-licenses`
  (claude-code-agent-manager#56, commit 5c7e587).
- **The Security Scan workflow was disabled for inactivity**, so govulncheck never ran on PRs; see
  actions-docker.md (claude-code-agent-manager#56).
- **Chromedp-style 0.x majors** need real code changes and a real-browser smoke test, which CI
  doesn't have (claude-code-agent-manager#58).
