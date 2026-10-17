// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { describeError, exitOnUnhandled } from './safe-error.js';

describe('describeError (#308)', () => {
  it('keeps a failed query’s SQL, parameters, and values out, and its code and frames in', () => {
    // As node-postgres reports a unique violation, wrapped as Drizzle wraps a failed query.
    const pg = Object.assign(new Error('duplicate key value violates unique constraint'), {
      name: 'DatabaseError',
      code: '23505',
      table: 'accounts',
      constraint: 'accounts_household_name_unique',
      detail: 'Key (name)=(Canary Checking) already exists.',
      where: 'SQL statement "insert ... -31337"',
    });
    const drizzle = new Error(
      'Failed query: insert into "transactions" ("display_name", "amount_minor") values ($1, $2)\nparams: Canary Coffee,-31337',
      { cause: pg },
    );
    drizzle.name = 'DrizzleQueryError';

    const text = describeError(drizzle);
    for (const secret of ['Canary', '31337', 'insert', 'params', 'already exists']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('DrizzleQueryError');
    expect(text).toContain(
      'caused by DatabaseError (code=23505, table=accounts, constraint=accounts_household_name_unique)',
    );
    expect(text).toMatch(/\n\s+at /);
  });

  it('describes what isn’t an Error without printing it', () => {
    expect(describeError({ amountMinor: -31337 })).toBe('a thrown object');
    expect(describeError('Canary Coffee')).toBe('a thrown string');
  });

  it('stops on a cause that loops', () => {
    const e = new Error('Canary');
    (e as { cause?: unknown }).cause = e;
    expect(describeError(e).split('caused by').length).toBe(6);
  });
});

describe('exitOnUnhandled (#308)', () => {
  it('logs an uncaught error without its message, then exits', () => {
    const before = process.listeners('uncaughtException');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const lines: string[] = [];
    exitOnUnhandled((m) => lines.push(m));
    const added = process.listeners('uncaughtException').filter((l) => !before.includes(l));
    try {
      process.emit('uncaughtException', new TypeError('Cannot parse "Canary Coffee -31337"'));
      expect(lines[0]).toMatch(/^uncaughtException: TypeError/);
      expect(lines[0]).not.toContain('Canary');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      for (const l of added) process.off('uncaughtException', l);
      for (const l of process.listeners('unhandledRejection').slice(-1)) {
        process.off('unhandledRejection', l);
      }
      exit.mockRestore();
    }
  });
});
