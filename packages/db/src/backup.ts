// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type pg from 'pg';

// Database dumps: before applying pending migrations (docs/design/upgrades.md §5, #277), and on a
// schedule (docs/security/backups.md, #306). Encrypted with age when there are recipients.

const run = promisify(execFile);

export interface BackupOptions {
  /** Where dumps go; created if missing. */
  dir: string;
  /** How many dumps of this kind to keep, newest first. */
  keep: number;
  /**
   * age recipients (public keys, `age1…`). With any, the dump is encrypted as it's written, and
   * only a matching identity (the private key, kept off the server) can read it. Without, it's
   * written as is.
   */
  recipients?: string[];
  /** The pg_dump to run (tests point it elsewhere). */
  pgDump?: string;
  /** The age to run (tests point it elsewhere). */
  age?: string;
}

/** A dump's file name: fiscus-<UTC time>-<before-<migration>|scheduled>.dump, then .age. */
const DUMP = /^fiscus-\d{8}T\d{6}Z-(before-.+|scheduled)\.dump(\.age)?$/;

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

/** A dump before applying migrations, named for the first: fiscus-<time>-before-<tag>.dump. */
export function backupDatabase(url: string, before: string, options: BackupOptions) {
  return dump(url, `before-${before.replace(/[^\w-]/g, '_')}`, options);
}

/** A scheduled dump: fiscus-<time>-scheduled.dump. */
export function scheduledBackup(url: string, options: BackupOptions) {
  return dump(url, 'scheduled', options);
}

/**
 * Dumps the database to `dir` (pg_dump's custom format, for pg_restore), then keeps only the
 * newest `keep` of the same kind. With recipients, pg_dump's output goes straight into age, so
 * the dump never touches the disk unencrypted. It's written under a temporary name and renamed
 * when complete, so a failed one never counts as a backup. The password goes to pg_dump in its
 * environment, not on its command line.
 */
async function dump(
  url: string,
  label: string,
  { dir, keep, recipients = [], pgDump = 'pg_dump', age = 'age' }: BackupOptions,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = '';
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const name = `fiscus-${stamp}-${label}.dump${recipients.length ? '.age' : ''}`;
  const partial = join(dir, `.${name}.partial`);
  const dumpArgs = ['--format=custom', '--dbname', parsed.toString()];
  const env = { ...process.env, PGPASSWORD: password };
  try {
    if (recipients.length) {
      await pipeInto(
        { name: 'pg_dump', command: pgDump, args: dumpArgs, env },
        {
          name: 'age',
          command: age,
          args: [...recipients.flatMap((r) => ['-r', r]), '-o', partial],
        },
      );
    } else {
      await run(pgDump, [...dumpArgs, '--file', partial], { env, maxBuffer: 16 * 1024 * 1024 });
    }
  } catch (err) {
    await rm(partial, { force: true });
    const e = err as {
      code?: string;
      path?: string;
      step?: string;
      stderr?: string;
      message: string;
    };
    throw new Error(
      e.code === 'ENOENT'
        ? `${e.path ?? pgDump} isn't installed here. Install it, or turn this backup off if you back up the database another way.`
        : `${e.step ?? 'pg_dump'} failed: ${(e.stderr || e.message).trim()}`,
      { cause: err },
    );
  }
  await rename(partial, join(dir, name));
  const kind = (f: string) => (DUMP.exec(f)![1]!.startsWith('before-') ? 'before' : 'scheduled');
  const same = (await readdir(dir))
    .filter((f) => DUMP.test(f) && kind(f) === kind(name))
    .sort()
    .reverse();
  for (const old of same.slice(keep)) await rm(join(dir, old));
  return join(dir, name);
}

interface Step {
  name: 'pg_dump' | 'age';
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs `from | to`, and fails with the failing side's stderr if either exits non-zero. Either
 * failing stops the other, so a half-written dump is never taken for a whole one.
 */
function pipeInto(from: Step, to: Step): Promise<void> {
  return new Promise((resolve, reject) => {
    const children = [
      spawn(from.command, from.args, { env: from.env, stdio: ['ignore', 'pipe', 'pipe'] }),
      spawn(to.command, to.args, { stdio: ['pipe', 'ignore', 'pipe'] }),
    ] as const;
    children[0].stdout.pipe(children[1].stdin);
    // The reader stopping early (a bad recipient) mustn't crash the writer on a closed pipe.
    children[1].stdin.on('error', () => undefined);
    let settled = false;
    let closed = 0;
    const fail = (err: object) => {
      if (settled) return;
      settled = true;
      for (const c of children) c.kill();
      reject(err);
    };
    [from, to].forEach((step, i) => {
      const child = children[i]!;
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err: NodeJS.ErrnoException) =>
        fail(Object.assign(err, { path: step.command })),
      );
      child.on('close', (code) => {
        if (code !== 0) {
          return fail({ step: step.name, message: `exited with ${code}`, stderr });
        }
        if (++closed === 2 && !settled) {
          settled = true;
          resolve();
        }
      });
    });
  });
}
