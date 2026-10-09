// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';

// A pg_dump before applying pending migrations (docs/design/upgrades.md §5, #277).

const run = promisify(execFile);

export interface BackupOptions {
  /** Where dumps go; created if missing. */
  dir: string;
  /** How many dumps to keep, newest first. */
  keep: number;
  /** The pg_dump to run (tests point it elsewhere). */
  pgDump?: string;
}

interface Journal {
  entries: { tag: string; when: number }[];
}

/**
 * Migrations in `folder` the database hasn't applied, by tag. Drizzle applies those newer than
 * the last one it recorded. Null on a fresh install (nothing applied yet: nothing to back up).
 */
export async function pendingMigrations(
  client: pg.Client,
  folder: string,
): Promise<string[] | null> {
  const journal = JSON.parse(
    await readFile(join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
  const { rows: exists } = await client.query<{ t: string | null }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations')::text AS t`,
  );
  if (!exists[0]?.t) return null;
  const { rows } = await client.query<{ last: string | null }>(
    'SELECT max(created_at)::text AS last FROM drizzle.__drizzle_migrations',
  );
  if (rows[0]?.last === null || rows[0]?.last === undefined) return null;
  const last = Number(rows[0].last);
  return journal.entries.filter((e) => e.when > last).map((e) => e.tag);
}

/**
 * Dumps the database to `dir` as fiscus-<UTC time>-before-<first pending>.dump (pg_dump's custom
 * format, for pg_restore), then keeps only the newest `keep`. The dump is written under a
 * temporary name and renamed when complete, so a failed one never counts as a backup. The
 * password goes to pg_dump in its environment, not on its command line.
 */
export async function backupDatabase(
  url: string,
  before: string,
  { dir, keep, pgDump = 'pg_dump' }: BackupOptions,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const name = `fiscus-${stamp}-before-${before.replace(/[^\w-]/g, '_')}.dump`;
  const partial = join(dir, `.${name}.partial`);
  try {
    await run(pgDump, ['--format=custom', '--file', partial, '--dbname', parsed.toString()], {
      env: { ...process.env, PGPASSWORD: password },
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    await rm(partial, { force: true });
    const e = err as { code?: string; stderr?: string; message: string };
    throw new Error(
      e.code === 'ENOENT'
        ? `${pgDump} isn't installed here. Install the PostgreSQL client, or set MIGRATE_BACKUP=false if you back up the database another way.`
        : `pg_dump failed: ${(e.stderr || e.message).trim()}`,
      { cause: err },
    );
  }
  await rename(partial, join(dir, name));
  const dumps = (await readdir(dir))
    .filter((f) => /^fiscus-\d{8}T\d{6}Z-before-.+\.dump$/.test(f))
    .sort()
    .reverse();
  for (const old of dumps.slice(keep)) await rm(join(dir, old));
  return join(dir, name);
}
