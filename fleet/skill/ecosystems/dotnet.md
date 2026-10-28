# .NET (NuGet)

Evidence: tanzu-genai-showcase#221 (dotnet-extensions-ai, net9.0 on SDK 9). One repo; thin.

## CI gates to find

- `dotnet build` / `dotnet test` and the SDK version (`global.json` or the workflow's
  `setup-dotnet`). tanzu's build job had been red since 2025-12-02 and went green with 0 warnings.
- `TreatWarningsAsErrors` / `WarningsAsErrors`: NU1605 (package downgrade) is an error by default.

## Audit

```bash
dotnet list package --vulnerable --include-transitive
```

Clean in tanzu after the bumps (tanzu-genai-showcase#221).

## Bumping a transitive-only package

Add or raise a direct `PackageReference` (or a `Directory.Packages.props` entry) to the needed
version; NuGet takes the highest requested. A direct pin lower than what the graph needs is the
NU1605 failure below.

## Publish dates

```bash
curl -s --compressed https://api.nuget.org/v3/registration5-gz-semver2/<id-lowercase>/<version>.json | jq -r .published
```

## Known traps

- **NU1605 forced a nominal major.** Direct pins of Microsoft.Extensions.Configuration(+Binder,
  EnvironmentVariables) 9.0.10 conflicted with the graph, which already required >= 10.0.0 through
  M.E.Http 10 and Steeltoe. Taking 10.0.13 was the only fix short of reverting earlier merges; it
  was flagged as a judgement call, and projects still target net9.0 (tanzu-genai-showcase#221).
- **In-major SDK bumps cascade across preview/beta lines.** SemanticKernel 1.44 → 1.81 moved
  M.E.AI.OpenAI from preview to 10.11.0 GA and Azure.AI.OpenAI from 2.2.0-beta.5 to 2.9.0-beta.1.
  It compiled cleanly, but with no tests and credential-gated runtime paths, behaviour was
  unverified; say so (tanzu-genai-showcase#221).
