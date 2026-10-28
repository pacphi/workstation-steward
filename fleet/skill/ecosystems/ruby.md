# Ruby (Bundler)

Evidence: tanzu-genai-showcase#221 (ruby-sinatra-fastmcp, Ruby 3.3.6) only, and nothing there was
run. Thin: treat this as a starting point.

## CI gates to find

- The test command and whether it can fail. tanzu's workflow runs
  `bundle exec rake test || echo "Test execution failed"`, so the job is always green and the
  green Dependabot runs prove nothing (tanzu-genai-showcase#221). Run the tests locally, and
  report the masking as a pre-existing CI defect.

## Audit

`bundle audit` (bundler-audit) is the usual tool; it wasn't run in the fleet. tanzu#221 checked
GitHub alerts and the advisory API (`gh api '/advisories?ecosystem=rubygems&affects=<gem>'`).

## Publish dates

```bash
curl -s https://rubygems.org/api/v1/versions/<gem>.json | jq -r '.[] | select(.number=="<version>") | .created_at'
```

## Known traps

- **Test-library majors change matching semantics.** mocha 3 turns on strict keyword-argument
  matching on Ruby 3, which likely breaks three expectations that pass a positional Hash
  (`test/flight_search_tool_test.rb`); minitest 6 needs Ruby 3.2+ and moves `minitest/mock` to a
  separate gem. Both deferred, with the expected fix written up (tanzu-genai-showcase#221, #193,
  #194).
