// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupDatabase } from './backup.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';

/** Pre-migration backups (docs/design/upgrades.md §5, #277), with a stand-in pg_dump. */
describe('backups before migrating', () => {
  let container: StartedPostgreSqlContainer;
  let work: string;
  let early: string; // the first few migrations, as an older release would have
  let dumps: string;
  let calls: string;
  let fakeDump: string;
  let failingDump: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('fiscus')
      .withUsername('fiscus_owner')
      .withPassword('test-owner-password')
      .start();
    work = mkdtempSync(join(tmpdir(), 'fiscus-backup-'));
    early = join(work, 'migrations');
    cpSync(MIGRATIONS_FOLDER, early, { recursive: true });
    const journalPath = join(early, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((e) => e.idx <= 5);
    writeFileSync(journalPath, JSON.stringify(journal));
    dumps = join(work, 'dumps');
    calls = join(work, 'calls.jsonl');
    // Records its arguments and whether the password came in its environment, then writes a dump.
    fakeDump = join(work, 'pg_dump');
    writeFileSync(
      fakeDump,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, password: process.env.PGPASSWORD }) + '\\n');
fs.writeFileSync(args[args.indexOf('--file') + 1], 'dump');
`,
    );
    failingDump = join(work, 'pg_dump_failing');
    writeFileSync(
      failingDump,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').writeFileSync(args[args.indexOf('--file') + 1], 'half a dump');
console.error('pg_dump: error: connection refused');
process.exit(1);
`,
    );
    chmodSync(fakeDump, 0o755);
    chmodSync(failingDump, 0o755);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const callLog = () =>
    existsSync(calls)
      ? readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { args: string[]; password: string })
      : [];

  it('skips a new database, fails closed, dumps before an upgrade, and skips when nothing is pending', async () => {
    const url = container.getConnectionUri();
    const backup = { dir: dumps, keep: 5, pgDump: fakeDump };

    // A new database: nothing to back up.
    await runMigrations(url, { migrationsFolder: early, backup });
    expect(callLog()).toEqual([]);

    // A dump that fails stops the upgrade, and leaves no half-written file behind.
    await expect(
      runMigrations(url, { backup: { ...backup, pgDump: failingDump } }),
    ).rejects.toThrow(/connection refused/);
    expect(readdirSync(dumps)).toEqual([]);

    // The upgrade: a dump first, named for the first migration it's about to apply.
    await runMigrations(url, { backup });
    const [call] = callLog();
    expect(call!.password).toBe('test-owner-password');
    expect(call!.args.join(' ')).not.toContain('test-owner-password');
    expect(call!.args).toContain('--format=custom');
    expect(readdirSync(dumps)).toEqual([
      expect.stringMatching(/^fiscus-\d{8}T\d{6}Z-before-0006_[\w-]+\.dump$/),
    ]);

    // Restarting with nothing to apply: no new dump.
    await runMigrations(url, { backup });
    expect(callLog()).toHaveLength(1);
  });

  it('keeps only the newest dumps', async () => {
    const dir = join(work, 'pruned');
    const url = container.getConnectionUri();
    for (const before of ['0001_a', '0002_b', '0003_c']) {
      await backupDatabase(url, before, { dir, keep: 2, pgDump: fakeDump });
      await new Promise((r) => setTimeout(r, 1100)); // names carry the time to the second
    }
    expect(readdirSync(dir).sort()).toEqual([
      expect.stringMatching(/-before-0002_b\.dump$/),
      expect.stringMatching(/-before-0003_c\.dump$/),
    ]);
  });
});
