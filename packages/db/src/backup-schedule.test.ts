// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nextScheduledBackupIn, waitAfterBackup } from './backup.js';

/** When scheduled backups run (docs/security/backups.md, #306). */
describe('the backup schedule', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = Date.UTC(2026, 9, 19, 12, 0, 0);
  const dirs: string[] = [];
  const dirWith = (...files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'fiscus-schedule-'));
    dirs.push(dir);
    for (const f of files) writeFileSync(join(dir, f), '');
    return dir;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('takes one at once with none yet, or none of its own kind', async () => {
    expect(await nextScheduledBackupIn(join(tmpdir(), 'fiscus-missing-dir'), DAY, now)).toBe(0);
    expect(await nextScheduledBackupIn(dirWith(), DAY, now)).toBe(0);
    // A pre-upgrade dump, and a half-written scheduled one, don't count.
    const dir = dirWith(
      'fiscus-20261019T110000Z-before-0042_x.dump.age',
      '.fiscus-20261019T113000Z-scheduled.dump.age.partial',
    );
    expect(await nextScheduledBackupIn(dir, DAY, now)).toBe(0);
  });

  it('after a restart, waits out the rest of the interval since the newest one', async () => {
    const dir = dirWith(
      'fiscus-20261018T090000Z-scheduled.dump.age',
      'fiscus-20261019T090000Z-scheduled.dump', // 3 hours ago, unencrypted
    );
    expect(await nextScheduledBackupIn(dir, DAY, now)).toBe(21 * HOUR);
    // Overdue: at once.
    expect(
      await nextScheduledBackupIn(dirWith('fiscus-20261017T090000Z-scheduled.dump.age'), DAY, now),
    ).toBe(0);
    // A clock that went back never waits longer than one interval.
    expect(
      await nextScheduledBackupIn(dirWith('fiscus-20261025T090000Z-scheduled.dump.age'), DAY, now),
    ).toBe(DAY);
  });

  it('tries a failed one again within the hour, and otherwise waits the interval', () => {
    expect(waitAfterBackup(true, DAY)).toBe(DAY);
    expect(waitAfterBackup(false, DAY)).toBe(HOUR);
    expect(waitAfterBackup(false, HOUR / 2)).toBe(HOUR / 2);
  });
});
