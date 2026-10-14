// SPDX-License-Identifier: AGPL-3.0-or-later
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';

/**
 * An upgraded install ends with the same schema as a fresh one (docs/design/upgrades.md §8).
 * Needs the previous release's migrations, so it runs in the upgrade-path workflow, which sets
 * FISCUS_PREVIOUS_MIGRATIONS (scripts/upgrade-check.sh); `pnpm test` skips it.
 */
const previous = process.env.FISCUS_PREVIOUS_MIGRATIONS;

/** Schema-only dump, without what differs between any two dumps (comments, session settings). */
async function schemaOf(container: StartedPostgreSqlContainer): Promise<string> {
  const dump = await container.exec([
    'pg_dump',
    '--username=fiscus_owner',
    '--dbname=fiscus',
    '--schema-only',
  ]);
  if (dump.exitCode !== 0) throw new Error(dump.stderr);
  return dump.stdout
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .filter((line) => !/^\\(un)?restrict /.test(line)) // a random key per dump (Postgres 18)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

describe.skipIf(!previous)('upgrading from the previous release', () => {
  const containers: StartedPostgreSqlContainer[] = [];
  const start = async () => {
    const c = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('fiscus')
      .withUsername('fiscus_owner')
      .withPassword('test-owner-password')
      .start();
    containers.push(c);
    return c;
  };

  afterAll(async () => {
    await Promise.all(containers.map((c) => c.stop()));
  });

  it('ends with the same schema as a fresh install', async () => {
    const [fresh, upgraded] = await Promise.all([start(), start()]);
    await runMigrations(fresh.getConnectionUri());
    // The previous release's database, then this release's migrations on top.
    await runMigrations(upgraded.getConnectionUri(), { migrationsFolder: previous! });
    await runMigrations(upgraded.getConnectionUri());

    const [want, got] = await Promise.all([schemaOf(fresh), schemaOf(upgraded)]);
    expect(want.length).toBeGreaterThan(1000);
    expect(got).toBe(want);
  }, 180_000);
});
