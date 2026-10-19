# Upgrades and migrations

- Status: Accepted (#236)
- Applies to: every PR that touches `packages/db/migrations`, and every release
- Related: [ADR 0002](../adr/0002-postgres-drizzle.md) (migrations never run on service boot), [ADR 0003](../adr/0003-independently-deployable-services.md) (services deploy independently), [ADR 0012](../adr/0012-member-lifecycle.md) / [ADR 0013](../adr/0013-tamper-evident-activity-history.md) (household data rules)

Self-hosters upgrade by pulling a new image tag and running `docker compose up -d`. These rules
keep that boring: no data loss, no downtime surprises, and a clear way back.

## 1. Principles
1. **One command to upgrade.** The one-shot `migrate` service applies pending migrations, then the
   new services start (compose ordering already enforces this).
2. **Never lose data.** A backup is taken automatically before any pending migration runs.
3. **Old code survives the new schema.** During a rollout (and on multi-host Proxmox setups), the
   previous version's api/worker may still be running against the migrated database. Migrations
   in release N must work with the code of release N−1.
4. **Forward only.** There are no "down" migrations. Mistakes are fixed with a new migration;
   rollback means restoring the pre-upgrade backup (§6).

## 2. Versions and supported upgrade paths
- SemVer tags (`vX.Y.Z`) via the release workflow (#12).
- **Within a major version:** any release upgrades directly to the latest. Migrations are
  cumulative, so there's no need to step through intermediate versions.
- **Across major versions:** upgrade to the **last minor of the current major** first, then to the
  next major. Release notes say so explicitly.
- **Before 1.0:** minor releases may contain breaking changes, but always come with a migration
  path and a release-note entry.

## 3. Expand / contract
Classify every schema change:

| Change | Safe in one release? | How |
|---|---|---|
| New table, new nullable column, new index on a small table, new enum value | ✅ Additive | One migration |
| New `NOT NULL` column | Two steps | Add nullable with a default → backfill → add the constraint in a **later** release |
| Rename a column or table | Expand → contract | Add the new one, write to both, backfill, switch reads, **drop the old one in a later release** |
| Change a column type | Expand → contract | New column, backfill, switch, drop later |
| Drop a column or table | Contract only | Only after a release in which **no code reads or writes it**, at least one minor release later |
| Remove an enum value | Contract only | Stop using it, migrate rows, then remove in a later release |
| New row-level security policy or trigger on a household table | ✅ | Required for household tables (ADR 0005/0013, enforced by tests) |

A PR that **contracts** (drops or narrows anything) must reference the earlier release that
stopped using it, and must be labeled `migration:contract`.

## 4. Writing migrations
- Generate with `pnpm db:generate`. Hand-written SQL (policies, triggers, functions) goes in custom
  migrations (`drizzle-kit generate --custom`).
- **Merged migrations are immutable.** Never edit or delete a migration that's on `main`; fix
  forward with a new one. *Enforced by CI* (`scripts/check-migrations.sh`).
- **Keep locks short.** Start long-running migrations with `SET lock_timeout = '5s';`, so a
  migration that can't get its lock fails fast instead of stalling the app. Large-table indexes use
  `CREATE INDEX CONCURRENTLY` in their own custom migration.
- **Separate data from schema.** Big backfills don't belong in a migration transaction. They run as
  an idempotent, batched, resumable worker job (an allow-listed maintenance job), and the release
  that depends on the backfill checks it has finished.
- Household tables must carry `household_id`, row-level security, and the write-marking trigger
  (tests fail otherwise).

## 5. Backups before upgrading
- The `migrate` job takes a **`pg_dump` before applying any pending migration** (#277), into the
  `db-backups` volume, as `fiscus-<UTC time>-before-<first migration>.dump` (pg_dump's custom
  format). It keeps the newest `MIGRATE_BACKUP_KEEP` (default 5). Opt out with
  `MIGRATE_BACKUP=false`, e.g. when the operator already snapshots the volume.
- If nothing is pending, or the database is new, no backup is taken, so routine restarts stay fast.
- **If the backup fails, nothing is migrated:** the job exits with pg_dump's error and the services
  keep running the version they had. A dump is written under a temporary name and renamed when
  complete, so a half-written one is never kept.
- **Encrypted** to `BACKUP_AGE_RECIPIENTS` when it's set, as `….dump.age`, like the scheduled
  backups ([backups](../security/backups.md)); restoring one then goes through `age -d` with the
  private key.
- **The encryption key is not in the dump.** Back up `APP_ENCRYPTION_KEY` separately
  ([encryption](../security/encryption.md)); a dump without its key can't decrypt protected fields.

### Restoring a pre-upgrade dump (compose)
The dumps are in the `db-backups` volume, which the `migrate` service mounts at `/backups` (its
image has `pg_restore`). To go back to one:

```bash
C="docker compose -f deploy/compose/docker-compose.yml"
$C run --rm --no-deps --entrypoint ls migrate -l /backups      # pick the dump
$C stop api worker web                                         # nothing writing meanwhile
$C exec db dropdb -U fiscus_owner --force fiscus               # the upgraded database
$C exec db createdb -U fiscus_owner fiscus
$C run --rm --no-deps --entrypoint sh migrate -c \
  'pg_restore --exit-on-error --dbname "$MIGRATION_DATABASE_URL" /backups/<file>.dump'
FISCUS_VERSION=<previous tag> $C up -d                         # the release that matches the dump
```

For an encrypted `….dump.age`, decrypt it on the way in, with the private key mounted for that
one command ([backups](../security/backups.md#restoring)).

The restore must go into an **empty** database: restoring over the upgraded one would leave the
newer release's objects behind, and its migrations would fail when you upgrade again.

## 6. Rollback
| Situation | What to do |
|---|---|
| New version misbehaves, release only **expanded** the schema | Redeploy the previous image tag. Old code works with the expanded schema (§1.3) |
| Release **contracted** the schema, or a migration failed partway | Stop the services, restore the pre-upgrade dump, redeploy the previous tag |

Migrations run in a transaction where Postgres allows, so a failure leaves the database unchanged
and the services keep running the old version. Release notes state which case applies.

## 7. Release notes
Each release lists:
- its migrations and whether any **contract**;
- required operator actions (new env vars, ones to remove);
- whether rollback needs a restore;
- the minimum version you can upgrade from directly.

## 8. CI checks
| Check | Status |
|---|---|
| Merged migrations are immutable (`scripts/check-migrations.sh`) | **In place** |
| Fresh install and upgraded install end with identical schemas (migrate from the previous release's database, compare `pg_dump --schema-only`) | **In place** (`scripts/upgrade-check.sh schema`, when migrations change) |
| The previous release's api test suite passes against the new schema (proves §1.3) | **In place** (`scripts/upgrade-check.sh api`, when migrations change) |
| Contract PRs are labeled and reference the release that stopped using the object | Review checklist |

## 9. PR checklist for migrations
- [ ] Additive, or expand/contract split across releases (§3)
- [ ] Works with the previous release's code
- [ ] No edits to merged migrations
- [ ] `lock_timeout` set or the operation is trivially fast; big backfills moved to a job
- [ ] Household tables: `household_id`, RLS, write trigger
- [ ] Release-note entry drafted if operators must act
