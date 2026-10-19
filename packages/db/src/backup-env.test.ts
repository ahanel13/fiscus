// SPDX-License-Identifier: AGPL-3.0-or-later
import { loadEnv } from '@fiscus/env';
import { describe, expect, it } from 'vitest';
import backupEnv from './backup-env.js';

describe('backup settings (#306)', () => {
  const url = 'postgres://fiscus_owner:pw@db:5432/fiscus';
  // In age's public key format: the first is the example in age's README.
  const one = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';
  const two = 'age1lggyhqrw2nlhcxprm67z43rta597azn8gknawjehu9d9dl0jq3yqqvfafg';

  it('reads recipients separated by spaces, commas, or lines, and defaults to none', () => {
    const load = (BACKUP_AGE_RECIPIENTS?: string) =>
      loadEnv(backupEnv, { source: { MIGRATION_DATABASE_URL: url, BACKUP_AGE_RECIPIENTS } });
    expect(load().BACKUP_AGE_RECIPIENTS).toEqual([]);
    expect(load(`${one}, ${two}`).BACKUP_AGE_RECIPIENTS).toEqual([one, two]);
    expect(load(`${one}\n${two}\n`).BACKUP_AGE_RECIPIENTS).toEqual([one, two]);
    expect(load().BACKUP_INTERVAL_HOURS).toBe(24);
    expect(load().BACKUP_KEEP).toBe(7);
  });

  it('refuses what isn’t an age public key, such as a private one', () => {
    for (const bad of ['ssh-ed25519 AAAA', 'AGE-SECRET-KEY-1QQQ', `${one}x`]) {
      expect(() =>
        loadEnv(backupEnv, {
          source: { MIGRATION_DATABASE_URL: url, BACKUP_AGE_RECIPIENTS: bad },
        }),
      ).toThrow(/BACKUP_AGE_RECIPIENTS/);
    }
  });
});
