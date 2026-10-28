# Contributing

![Revision 1](https://img.shields.io/badge/Revision-1-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

Thanks for helping. The steward changes people's machines, so changes are judged first on whether they stay safe:
read-only by default, and a plan, a yes, a backup and a receipt for anything that writes.

## Set up

You need macOS, Git, [mise](https://mise.jdx.dev), and the tools in
[`examples/mise/config.toml`](examples/mise/config.toml): Node 26, just, yq, gh and shellcheck, plus lychee and
markdownlint-cli2 for `just docs`, and Biome and TypeScript for `just lint`. `steward doctor` says which are missing.

```sh
git clone https://github.com/pacphi/workstation-steward && cd workstation-steward
export STEWARD_INSTANCE="$PWD/examples"  # the example instance; never your own while developing
npm ci --ignore-scripts --prefix tools/types   # dev only: Node's type definitions for the type check (D45)
just test && just lint && just docs
npm link                                 # puts this clone's `steward` on your PATH
steward check
just leak-check                          # before every push: nothing private in what goes public
```

Keep your own private words (repo, client and user names) in `leak-terms.txt` in your config; `just leak-check` reads
it from there, so the list itself is never published.

## Making a change

- **Read first:** [`docs/architecture.md`](docs/architecture.md) for the design and the numbered decisions (D1, D2 …),
  and the area's runbook under `docs/<area>/`.
- **Commands that write** follow the same shape: a read-only plan by default; `--apply` (or a `[y/N]`) to act; a
  backup before the first write; a receipt under the state folder; a way back (`--undo`, `--rollback` or
  `steward sc rollback`). `DRY_RUN=1` previews any of them.
- **No machine data in code.** Paths and roots come from `steward.toml` (`lib/config.js`); policy comes from the
  instance's files. Never hard-code a home folder, a project or a repo.
- **Shell is macOS bash 3.2:** no `mapfile`, associative arrays or `${var,,}`; guard empty arrays under `set -u`.
  Run `just lint`: shellcheck for the Bash, Biome and the TypeScript checker for the JavaScript (D45).
- **Tests** go in `test/` (`node:test`, no network; spawn the scripts against throwaway folders and a temp
  instance). Every fix comes with the test that would have caught it.
- **Decisions** that change behavior get a row in the table in `docs/architecture.md`, with the reason.
- **Long commands** show progress: a live timer and timed milestones (`lib/progress.js`, `quiet` in `lib/lib.sh`).

## Pull requests

One topic per PR, with a title in the [Conventional Commits](https://www.conventionalcommits.org) style
(`feat(sc): …`, `fix(ai): …`, `docs: …`). Say what you ran to check it. Dependency updates come from Renovate and
wait out the 3-day release-age gate; a security fix that can't wait names its advisory.

AI-assisted contributions are welcome under the same bar: you've read and run what you submit.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
