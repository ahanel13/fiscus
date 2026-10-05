// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('.', import.meta.url));

/**
 * Files allowed to use the database handle directly. Everything else reaches the database through
 * HouseholdScope, so every household query carries the household context that row-level security
 * enforces (#18/#19). Adding a file here needs a reason in the comment.
 */
const DIRECT_DB_ALLOWED: Record<string, string> = {
  'database/database.module.ts': 'provides the handle',
  'crypto/crypto.module.ts': 'wires the key store; keys are household-checked by FieldCrypto',
  'health/health.controller.ts': 'readiness ping only',
  'households/household-scope.ts': 'the gate itself',
  'households/household-access.ts': 'user-level membership lookups across households',
  'households/invite-tokens.service.ts':
    'token lookup before membership exists (definer function in #19)',
  'auth/session.service.ts': 'users and sessions are instance-level, not household data',
  'auth/auth.service.ts': 'users and reset tokens are instance-level',
  'auth/setup.service.ts': 'first-run setup is instance-level',
  'audit/audit.service.ts': 'moves into the household transaction with #263',
};

const DIRECT_DB = /@Inject\(DB\)|\bDbHandle\b/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'testing' ? [] : sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('architecture', () => {
  it('only allow-listed files touch the database directly', () => {
    const offenders = sources(SRC)
      .map((path) => relative(SRC, path))
      .filter((rel) => !(rel in DIRECT_DB_ALLOWED))
      .filter((rel) => DIRECT_DB.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders, 'Use HouseholdScope.run(ctx, tx => …) instead of the raw DB handle').toEqual(
      [],
    );
  });

  it('keeps the allow-list honest (no stale entries)', () => {
    const files = new Set(sources(SRC).map((path) => relative(SRC, path)));
    expect(Object.keys(DIRECT_DB_ALLOWED).filter((rel) => !files.has(rel))).toEqual([]);
  });
});
