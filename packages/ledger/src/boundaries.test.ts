// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

// The api and the worker both run this, so it may not reach into either app or rely on Nest's
// request scope: callers hand it the transaction, household, and actor (ADR 0003, #401).
describe('@fiscus/ledger boundaries', () => {
  it('imports nothing from the apps or Nest', () => {
    const offenders = readdirSync(SRC)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) =>
        /from '(@nestjs\/|@fiscus\/(api|worker|mcp|web)\b|(\.\.\/)+apps\/)/.test(
          readFileSync(`${SRC}/${name}`, 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
