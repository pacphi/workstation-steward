# Security policy

![Revision 1](https://img.shields.io/badge/Revision-1-green) ![Revised 2026-10-27](https://img.shields.io/badge/Revised-2026--10--27-green)

workstation-steward changes software on your Mac and runs as you. It installs and removes tools, edits launcher
configs in your projects, and reads trust stores. A flaw in it is a flaw on every machine that runs it, so reports
are welcome and handled first.

## Supported versions

Only the newest release gets fixes. Upgrade with your instance's mise pin (`npm:workstation-steward`), which waits
out the release-age gate like any other tool, or take a fixed release at once as a security exception.

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/pacphi/workstation-steward/security/advisories/new).

Include what an attacker could do, the version or commit, and the steps to reproduce. This is a one-maintainer
project: expect an acknowledgement within a few days and a fix or a plan within two weeks. You'll be credited in the
advisory unless you ask not to be.

## What counts

- A command that changes something without its plan and your yes, or without a backup and a receipt.
- Anything that runs code from a download before checking it, or installs past the release-age gate or a pin.
- Leaks of tokens, paths or project names into logs, receipts, PRs or published artifacts.
- Escaping the folders a command says it will touch.

Out of scope: vulnerabilities in the tools the steward manages (report those upstream; the steward's job is to
apply their fixes), and findings that need an attacker who already runs code as you.
