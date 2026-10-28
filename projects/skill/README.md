# projects-steward

A Claude Code skill for workstation-steward's projects under ~/Development (discovery, registry, decisions). [`SKILL.md`](SKILL.md) is the skill itself. The
procedures it follows are in [`docs/projects/runbook.md`](../../docs/projects/runbook.md). In this repo it loads
automatically: `.claude/skills/projects-steward` links to this folder.

## Install

**In this repo** there's nothing to do. Claude Code loads `.claude/skills/projects-steward`, which links here, in any
session started in the checkout.

**Elsewhere** (optional): to use the skill from other directories, link it into your personal skills. Run
this from the repo root:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/projects/skill" ~/.claude/skills/projects-steward
```

If the checkout moves, recreate the link with `ln -sfn`. The skill moves into the checkout before running
anything.

## Check, update, uninstall

- **Check:** start a new Claude Code session (in this repo, or anywhere after a personal install) and type `/`; `projects-steward` should be listed. If it isn't, run
  `ls -L ~/.claude/skills/projects-steward/SKILL.md`.
- **Update:** `git pull` in this repo. Edits are picked up without a restart.
- **Uninstall (personal):** `rm ~/.claude/skills/projects-steward` removes the symlink only.
