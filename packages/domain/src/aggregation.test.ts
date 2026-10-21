// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isProviderError, ProviderError } from './aggregation.js';

describe('ProviderError', () => {
  const error = new ProviderError('rate_limited', {
    providerCode: 'RATE_LIMIT_EXCEEDED',
    retryAfterMs: 60_000,
    providerMessage: 'Too many requests for Alex Rivera at Harbor Credit Union',
  });

  it('carries the kind, code and retry delay', () => {
    expect(isProviderError(error)).toBe(true);
    expect(error).toMatchObject({ kind: 'rate_limited', providerCode: 'RATE_LIMIT_EXCEEDED' });
    expect(error.retryAfterMs).toBe(60_000);
    expect(error.message).toBe('Provider error: rate_limited (RATE_LIMIT_EXCEEDED)');
  });

  it("keeps the provider's message for display, out of the message and JSON", () => {
    expect(error.providerMessage).toContain('Harbor Credit Union');
    expect(JSON.stringify(error)).not.toContain('Harbor');
    expect(Object.keys(error)).not.toContain('providerMessage');
    expect(String(error)).not.toContain('Harbor');
  });

  it('is not confused with other errors', () => {
    expect(isProviderError(new Error('Provider error: transient (X)'))).toBe(false);
  });
});
