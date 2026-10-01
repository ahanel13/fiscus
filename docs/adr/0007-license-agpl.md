# ADR 0007: License: AGPL-3.0-or-later

- Status: Accepted
- Date: 2026-10-01

## Context
The maintainer is happy for anyone, including companies, to use, modify, and commercialize
the project, but wants **modifications published**, not kept closed. Fiscus is a
network service, so the most likely commercial reuse is *hosting* it, not distributing copies.

| License | Commercial use | Must publish changes? |
|---------|----------------|-----------------------|
| MIT | Yes | No: a fork can be closed |
| GPL-3.0 | Yes | Only when *distributing* binaries/source. Hosting a modified copy as a service does not count (the "SaaS loophole") |
| **AGPL-3.0** | Yes | **Yes, including when users interact with it over a network** (§13) |

## Decision
- License the project under **GNU AGPL-3.0-or-later**. The full text is in `/LICENSE`.
- Source files carry the SPDX header `// SPDX-License-Identifier: AGPL-3.0-or-later`.
- Contributions are accepted under the same license, using a **DCO** (`Signed-off-by:` on each
  commit) rather than a CLA.
- The web UI's About page links to the source repository, which satisfies §13's "offer source to network users".

## Consequences
- Companies can use, sell, and host it, but anyone running a modified version for users must publish their changes under AGPL.
- Without a CLA, the project can't later be relicensed or sold under proprietary exceptions
  without every contributor's consent. This is accepted; revisit only if dual-licensing ever becomes a goal.
- Dependencies must be AGPL-compatible: MIT, BSD, Apache-2.0, ISC, MPL-2.0, LGPL, or GPL-3.0.
  CI runs a license check to block incompatible ones.
