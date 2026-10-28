# JVM (Maven, Gradle)

Evidence: tanzu-genai-showcase#221 (two Spring samples and an Angular frontend built by Maven);
a client JVM + Next.js app (#304 was still open at the time of writing). Thin: no
Gradle repo and no Maven audit gate appeared in the fleet. cf-archivist (triage notes-A) had open
bouncycastle alerts but no consolidation run.

## CI gates to find

- `./mvnw verify` (or the workflow's exact goals), the JDK distribution and version (tanzu's CI
  uses Liberica 21, not Temurin), and plugins that do more than compile:
  - `frontend-maven-plugin` installs its own Node (v20.13.0 in tanzu) and runs `npm run build` in
    `generate-resources`, before `compile` (tanzu-genai-showcase#221);
  - `openapi-generator-maven-plugin` writes `src/generated` during `generate-sources`, so the web
    app's typecheck, tests and build fail outside the Maven build (a client JVM + Next.js app);
  - `spring-boot-maven-plugin` `build-image` pulls a Paketo builder (below).
- When a non-Java change can only be validated through Maven, say so: a client JVM + Next.js app treated
  CI's `./mvnw verify` as the authoritative gate.

## Audit

No Maven audit job existed in the evidenced repos. Use GitHub alerts and the advisory API:

```bash
gh api repos/<repo>/dependabot/alerts --jq '.[] | select(.state=="open" and .dependency.package.ecosystem=="maven")'
gh api '/advisories?ecosystem=maven&affects=<groupId>:<artifactId>'
```

Cross-check on osv.dev, as tanzu#221 did.

## Bumping a transitive-only dependency

Not exercised in the fleet. A BOM import overrides the version a starter would bring:
tanzu's `mcp-bom` overrode the MCP SDK version that Spring AI was built against
(tanzu-genai-showcase#221, #207), so check what the BOM displaces before bumping it.

## Publish dates

```bash
curl -s 'https://search.maven.org/solrsearch/select?q=g:<groupId>+AND+a:<artifactId>+AND+v:<version>&wt=json' \
  | jq -r '.response.docs[0].timestamp / 1000 | todate'
```

For container images (Paketo builders), see actions-docker.md.

## Known traps

- **A framework major merged without code changes breaks the build long after.** Spring Boot
  3.5 → 4.0 was merged in tanzu #158/#159 with no code changes; the langgraph backend then failed
  with 33 javac errors (Boot 4's starter split, missing Spring AI packages), and java-spring-ai-mcp
  didn't compile either. Seven in-major Dependabot PRs for those modules couldn't be validated and
  were left open (tanzu-genai-showcase#221). Don't consolidate into a module that doesn't compile
  on the base branch; report it.
- **Starter versions track Boot majors.** `spring-boot-starter-httpclient5` 2.x inherits
  `spring-boot-starter-parent` 4.0.1; a Boot 3.4 project needs 1.2.x. Read the parent POM before
  calling a bump in-major-safe (tanzu-genai-showcase#221, #203).
- **The Paketo builder `latest` tag was re-pushed arm64-only** on 2026-10-23 14:50 UTC; amd64
  runners failed with `exec /cnb/lifecycle/creator: exec format error`. Spring Boot's default
  builder is unpinned, so pin it by digest through a property used by every `<image><builder>`
  (a client JVM + Next.js app, 0.0.197, the newest builder at least 3 days old).
- **Build-plugin majors carry build-time CVEs only.** frontend-maven-plugin 2.0 raises minimums
  to Java 17 / Maven 3.6 and fixes its own commons-compress; deferred as low-risk
  (tanzu-genai-showcase#221, #198).
