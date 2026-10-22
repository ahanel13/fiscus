// SPDX-License-Identifier: AGPL-3.0-or-later
import { ProviderError } from '@fiscus/domain';
import { describe, expect, it } from 'vitest';
import { Problem } from '../common/problem.js';
import { plaidProblem } from './plaid.js';

const problem = (kind: ConstructorParameters<typeof ProviderError>[0], providerCode: string) => {
  try {
    plaidProblem(new ProviderError(kind, { providerCode }));
  } catch (err) {
    return err as Problem;
  }
  throw new Error('plaidProblem returned');
};

describe('plaidProblem', () => {
  it('says the connection is gone when Plaid no longer has the Item or its token', () => {
    for (const code of ['INVALID_ACCESS_TOKEN', 'ITEM_NOT_FOUND']) {
      const p = problem('invalid_credentials', code);
      expect(p).toBeInstanceOf(Problem);
      expect(p.getStatus()).toBe(409);
      expect(p.code).toBe('connection_gone');
    }
    // The server's keys refused is another matter.
    expect(problem('invalid_credentials', 'INVALID_API_KEYS').code).toBe('plaid_keys_refused');
  });
});
