---
name: sc-audit
description: "Read-only supply-chain audit: Homebrew, apps, App Store, macOS, trust stores, Docker and IOCs against host.toml. Runs `steward sc audit` and summarizes it; changes nothing."
disable-model-invocation: true
allowed-tools: Bash(steward sc audit) Bash(steward sc audit *)
argument-hint: "[flags]"
---

Run `steward sc audit $ARGUMENTS` from the root of this repo. It's read-only.

Group the ACTION lines by kind (Homebrew, browsers, other apps, App Store, macOS, Docker). Put any ALERT (an indicator of compromise matched) first, as a stop-and-investigate item.

End with the next step the owner might want. Don't take it. Anything that changes state belongs to the
`supply-chain-steward` skill and its runbook, one approved step at a time.
