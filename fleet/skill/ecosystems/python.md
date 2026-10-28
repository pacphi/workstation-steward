# Python

Evidence: tanzu-genai-showcase#221 (py-django-crewai: `requirements.txt` and
`utils/favicon_requirements.txt`). One repo; no uv, poetry or pyproject-managed project was
consolidated in the fleet, so this file is thin.

## CI gates to find

- How CI installs: `pip install -r requirements.txt`, uv, poetry. Which Python (tanzu used 3.12
  locally in the official image).
- Whether tests actually run. tanzu's `manage.py test` needs `TMDB_API_KEY`, and CI masks the
  failure, so a green job proves little (tanzu-genai-showcase#221).

## Audit

```bash
pip-audit -r requirements.txt          # per requirements file
gh api repos/<repo>/dependabot/alerts --jq '.[] | select(.dependency.package.ecosystem=="pip")'
```

In tanzu#221, pip-audit left 7 findings in packages pinned by crewai 1.15.28 (chromadb, mcp,
uv), each assessed for reachability (the app isn't a Chroma server, an MCP server, or a uv user),
with the exit condition "a crewai release that relaxes these pins". Pillow's remaining advisories
in the dev-only favicon generator needed 13.0 (a major) and were deferred.

## Bumping a transitive-only package

Requirements files that pin only direct dependencies can't hold transitive versions; add a pin or
a constraints file, inside the parent's allowed range. Check the parent's caps first: crewai
capped pydantic `<2.13`, so 2.12.5 was the ceiling (tanzu-genai-showcase#221, #174).

## Publish dates

```bash
curl -sL https://pypi.org/pypi/<name>/<version>/json | jq -r '[.urls[].upload_time_iso_8601] | min'
```

## Known traps

- **Unlocked requirements drift in CI.** With only direct pins, CI resolves transitive packages
  fresh on every run; tanzu's local resolution pulled langchain-core 1.7.0, grpcio 1.84.1 and
  others under 3 days old. Recommend committing a lock or constraints file, or
  `uv pip compile --exclude-newer <date>` (tanzu-genai-showcase#221).
- **Check optional extras before assuming exposure.** crewai declares LiteLLM only as an extra
  (`requires_dist: litellm<2,>=1.88.6; extra == "litellm"` for every 1.15.x release on PyPI), and
  tanzu pins plain `crewai==1.15.28`. That matters for incidents like the LiteLLM image-tag
  hijack of 2026-10-21 (cited in ruflo-local#34). Check with:
  `curl -s https://pypi.org/pypi/crewai/<ver>/json | jq '.info.requires_dist[] | select(test("litellm"))'`.
- **Big in-major jumps of AI SDKs** (crewai 1.6 → 1.15, langchain 1.1 → 1.4) compile but change
  runtime behaviour that nothing tested; say so in the PR body (tanzu-genai-showcase#221).
- Skip versions released the same day even when they're the newest (langchain 1.4.7 was 0 days
  old; tanzu-genai-showcase#221).
