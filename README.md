# Fiscus

> *fiscus* (Latin): the household money-basket; the root of "fiscal".

Fiscus is a self-hosted, open-source personal finance platform for households and couples.
It covers bank sync, flexible budgeting (zero-based, 50/30/20, flex, per-category),
yours / mine / ours shared finances with settle-up, bills, goals, investments, forecasting and
FIRE planning, AI receipt scanning, reporting, notifications, and an optional AI assistant and
MCP server that can run on a local model.

**Status:** early. The [latest release](https://github.com/ahanel13/fiscus/releases/latest) is the core
ledger: households and invites, accounts and net worth, transactions with splits and tags,
imports from Monarch and bank CSV files, rules, and transfers between your accounts, with daily
encrypted backups and master key rotation. Its images are reproducible and signed
([verifying a release](docs/security/verify-releases.md)), and the
[security page](docs/security/README.md) says what protects your data. Bank sync, budgets, bills,
and the rest follow in later milestones (see the roadmap). Expect breaking changes before 1.0.

- [Architecture](docs/architecture.md)
- [Roadmap & backlog](docs/roadmap.md)
- [Monarch feature parity](docs/monarch-parity.md)
- [Architecture decision records](docs/adr/)
- [Contributing / workflow](CONTRIBUTING.md)

## Install
You need Docker with Compose v2, on amd64 or arm64.

```sh
mkdir fiscus && cd fiscus
curl -fsSLO https://github.com/ahanel13/fiscus/releases/latest/download/docker-compose.yml
curl -fsSL https://github.com/ahanel13/fiscus/releases/latest/download/env.example -o .env
```

Both come from the latest release, and `.env` is already pinned to it (`FISCUS_VERSION`), so
upgrades happen when you choose.

Edit `.env`:
- `POSTGRES_PASSWORD` and `APP_DATABASE_PASSWORD`: `openssl rand -hex 24` for each. Optionally
  `WORKER_DATABASE_PASSWORD` too, for the worker's own database role; unset, it uses the app's.
- `APP_ENCRYPTION_KEY`: `openssl rand -base64 32`. **Back it up somewhere other than your
  database backups.** Without it, encrypted data can't be recovered
  ([why](docs/security/encryption.md)).
- `BACKUP_AGE_RECIPIENTS`: the public key (`age1…`) that daily backups are encrypted to. Make
  the key pair **on your own computer** with `age-keygen -o fiscus-backup-key.txt`, and keep that
  file off the server ([backups](docs/security/backups.md)).
- `FISCUS_PUBLIC_URL`: the address people will use, e.g. `https://fiscus.example.com`.

Then start it and find the one-time setup token:

```sh
docker compose up -d --wait
docker compose logs api | grep "setup token"
```

Open `http://localhost:8080` (or your public URL), enter the token, and create the admin account.
After that, signup is invite-only: invite people from **Server** in your account menu, or from
your household's menu to share a household.

By default Fiscus listens on `127.0.0.1:8080` only. Put it behind a reverse proxy with HTTPS
(Caddy, nginx, Traefik), or see the comments in `.env` for LAN access over plain HTTP.

**Backups:** the database is dumped daily into the `db-backups` volume. Copy the encrypted files
off the server, put the volume itself on an encrypted disk, and try a restore now and then
([backups](docs/security/backups.md)).

**Upgrading:** download the new release's `docker-compose.yml` (the first `curl` above), set
`FISCUS_VERSION` in `.env` to it, then `docker compose pull && docker compose up -d --wait`. The
database is backed up automatically before any migration runs ([upgrades](docs/design/upgrades.md)).
Read the release notes first.

**Checking what you run:** every release's images are signed, come with SBOMs, and rebuild from
the source to the same digest. The release notes list the digests;
[verifying a release](docs/security/verify-releases.md) shows how to check yours.

### Plaid keys
Bank connections through Plaid use the server's own Plaid keys, from
[Plaid's dashboard](https://dashboard.plaid.com). Set all three in `.env`, or none:

- `PLAID_CLIENT_ID` and `PLAID_SECRET` (or `PLAID_SECRET_FILE`, like every variable).
- `PLAID_ENV`: `production` for real banks, or `sandbox` for Plaid's test banks and test data.
  Each environment has its own secret, and a bank connected in one doesn't work in the other.
- Optionally `PLAID_REDIRECT_URI`, an `https` address listed in Plaid's dashboard, for banks
  whose sign-in happens on their own site.

Without them, Plaid is unavailable, unless a household adds its own keys. With only some set,
the api and worker don't start, and say which are missing. The api logs say only
`Plaid: configured (production)` or `Plaid: not configured`, never the keys. Changing the
secret is safe; changing the client id or the environment means reconnecting every bank made
with the old ones, and Fiscus marks those connections "reconnect".

**Trying sandbox on a server that has real data:** don't switch `PLAID_ENV` on it. Run sandbox
as a separate stack, with its own `.env`, port and volumes, under another project name:

```sh
mkdir ../fiscus-sandbox && cp docker-compose.yml ../fiscus-sandbox/ && cd ../fiscus-sandbox
curl -fsSL https://github.com/ahanel13/fiscus/releases/latest/download/env.example -o .env
# In this .env: new passwords and APP_ENCRYPTION_KEY, PLAID_ENV=sandbox with the sandbox
# secret, and FISCUS_PORT=8081.
docker compose -p fiscus-sandbox up -d --wait
```

`-p fiscus-sandbox` gives it its own containers and volumes, so it never touches the real
database. The compose file names its project `fiscus`, so every command for the sandbox stack
needs `-p fiscus-sandbox`; remove it with `docker compose -p fiscus-sandbox down -v`.

## Security
What Fiscus protects, from whom, and where your data goes: [security](docs/security/README.md).
To report a vulnerability, see [SECURITY.md](SECURITY.md). Please don't open a public issue.

## Trust model
The operator of a Fiscus instance can technically access the data stored on it. Only join an
instance run by someone you'd trust with your bank statements, or run your own.
See [ADR 0005](docs/adr/0005-tenancy-and-trust-model.md).

## License
[AGPL-3.0-or-later](LICENSE). You may use, modify, and host Fiscus, including commercially,
but modified versions offered to users must publish their source: set `FISCUS_SOURCE_URL` so the
app links to it.

Fiscus is an independent project and is not affiliated with Monarch Money.
