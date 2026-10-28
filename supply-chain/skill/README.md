# supply-chain-steward

A Claude Code skill for workstation-steward's supply chain (mise, Homebrew, apps, App Store, macOS, trust stores, Docker, IOCs). [`SKILL.md`](SKILL.md) is the skill itself. The
procedures it follows are in [`docs/supply-chain/runbook.md`](../../docs/supply-chain/runbook.md). In this repo it loads
automatically: `.claude/skills/supply-chain-steward` links to this folder.

## Install

**In this repo** there's nothing to do. Claude Code loads `.claude/skills/supply-chain-steward`, which links here, in any
session started in the checkout.

**Elsewhere** (optional): to use the skill from other directories, link it into your personal skills. Run
this from the repo root:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/supply-chain/skill" ~/.claude/skills/supply-chain-steward
```

If the checkout moves, recreate the link with `ln -sfn`. The skill moves into the checkout before running
anything.

## Check, update, uninstall

- **Check:** start a new Claude Code session (in this repo, or anywhere after a personal install) and type `/`; `supply-chain-steward` should be listed. If it isn't, run
  `ls -L ~/.claude/skills/supply-chain-steward/SKILL.md`.
- **Update:** `git pull` in this repo. Edits are picked up without a restart.
- **Uninstall (personal):** `rm ~/.claude/skills/supply-chain-steward` removes the symlink only.
