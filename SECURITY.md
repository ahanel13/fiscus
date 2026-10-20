# Security policy

Fiscus holds people's financial data, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:
[**Report a vulnerability**](https://github.com/ahanel13/fiscus/security/advisories/new)
(the repository's Security tab → Advisories → Report a vulnerability).

Include what you found, how to reproduce it, which version or commit, and the impact you expect.
A proof of concept helps, but please don't access data that isn't yours.

What to expect:
- An acknowledgement within a few days. Fiscus is maintained by volunteers, so please allow time.
- A fix in a release, then a published advisory crediting you, unless you'd rather not be named.
- Please keep it private until a fixed release is out, or 90 days have passed, whichever is
  first. If you need longer or shorter, ask.

## Supported versions

Fiscus is before 1.0. Only the latest release gets security fixes. Upgrade to it first.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Scope

In scope: the code in this repository and the published images
(`ghcr.io/ahanel13/fiscus-*`), for example:
- one household or person reading or changing another's data
- getting past sign-in, a session, CSRF protection, or a role's permissions
- recovering encrypted data without the encryption key
- injection, SSRF, or code execution in the API, worker, web, or MCP server

Not vulnerabilities:
- **The operator can see the data on their instance.** That's the documented trust model
  ([ADR 0005](docs/adr/0005-tenancy-and-trust-model.md)): someone with the server and its
  encryption key can read what's stored there.
- Problems that need the instance to be set up against the guidance in `.env`, such as plain HTTP
  across an untrusted network with `FISCUS_COOKIE_SECURE=false`.
- Vulnerabilities in third-party dependencies with no demonstrated effect on Fiscus. Report those
  upstream. If one does affect Fiscus, report it here.

## How Fiscus is built to be safe

- [Encryption at rest](docs/security/encryption.md)
- [Backups and encrypted storage](docs/security/backups.md)
- [Verifying a release](docs/security/verify-releases.md): reproducible, signed images with SBOMs.
- [Tenancy and trust model](docs/adr/0005-tenancy-and-trust-model.md)
- [Permissions matrix](docs/design/permissions.md): every rule is tested for each role.
