# ai-tooling-steward

A Claude Code skill for workstation-steward's AI tooling (Ruflo, AgentDB, AQE, Brain, RuVector, launchers, guards). [`SKILL.md`](SKILL.md) is the skill itself. The
procedures it follows are in [`docs/ai-tooling/runbook.md`](../../docs/ai-tooling/runbook.md). In this repo it loads
automatically: `.claude/skills/ai-tooling-steward` links to this folder.

## Install

**In this repo** there's nothing to do. Claude Code loads `.claude/skills/ai-tooling-steward`, which links here, in any
session started in the checkout.

**Elsewhere** (optional): to use the skill from other directories, link it into your personal skills. Run
this from the repo root:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/ai-tooling/skill" ~/.claude/skills/ai-tooling-steward
```

If the checkout moves, recreate the link with `ln -sfn`. The skill moves into the checkout before running
anything.

## Check, update, uninstall

- **Check:** start a new Claude Code session (in this repo, or anywhere after a personal install) and type `/`; `ai-tooling-steward` should be listed. If it isn't, run
  `ls -L ~/.claude/skills/ai-tooling-steward/SKILL.md`.
- **Update:** `git pull` in this repo. Edits are picked up without a restart.
- **Uninstall (personal):** `rm ~/.claude/skills/ai-tooling-steward` removes the symlink only.
