// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  SimpleFinTokenError,
  simpleFinProviderAccount,
  simpleFinProviderBalance,
} from '@fiscus/aggregation';
import { isProviderError } from '@fiscus/domain';
import type { AccountType } from '@fiscus/shared';
import { Problem } from '../common/problem.js';

// The api's side of SimpleFIN (#91): the Bridge's failures as api problems, worded for the
// person (the fix is at the Bridge), and its accounts in the shape choosing them reads. Nothing
// here logs; a token's URLs never reach a problem.

type SimpleFinAccount = Parameters<typeof simpleFinProviderAccount>[0];

/** A Bridge account as the choose step reads it, or null when its currency isn't supported. */
export function fromSimpleFin(a: SimpleFinAccount) {
  const account = simpleFinProviderAccount(a);
  if (!account) return null;
  const balance = simpleFinProviderBalance(a);
  return {
    providerAccountId: account.providerAccountId,
    name: account.name,
    officialName: null,
    type: account.type satisfies AccountType,
    subtype: account.subtype ?? null,
    mask: account.mask ?? null,
    currency: account.currency,
    balance: balance ? { amountMinor: balance.currentMinor, currency: balance.currency } : null,
  };
}

/** A token or Bridge failure as an api problem; anything else is rethrown. */
export function simpleFinProblem(err: unknown): never {
  if (err instanceof SimpleFinTokenError) {
    throw new Problem(
      422,
      err.code === 'token_used'
        ? 'setup_token_used'
        : err.code === 'host_not_allowed'
          ? 'setup_token_host'
          : 'not_a_setup_token',
      err.message,
      err.code === 'not_a_token'
        ? 'Copy the setup token the SimpleFIN Bridge shows after you connect your banks there.'
        : undefined,
    );
  }
  if (!isProviderError(err)) throw err;
  const ext = { providerCode: err.providerCode };
  switch (err.kind) {
    case 'login_required':
      throw new Problem(
        409,
        'bridge_access_revoked',
        'The SimpleFIN Bridge no longer gives Fiscus access',
        'Create a new setup token at the Bridge, and connect with it.',
        undefined,
        {},
        ext,
      );
    case 'consent_expired':
      throw new Problem(
        409,
        'bridge_subscription',
        'Your SimpleFIN Bridge subscription needs renewing',
        'Renew it at the Bridge, then try again.',
        undefined,
        {},
        ext,
      );
    case 'rate_limited':
      throw new Problem(
        429,
        'rate_limited',
        'The SimpleFIN Bridge asked us to slow down',
        'Try again later.',
        undefined,
        { 'retry-after': String(Math.max(1, Math.ceil((err.retryAfterMs ?? 60_000) / 1000))) },
        ext,
      );
    default:
      throw new Problem(
        502,
        'provider_unavailable',
        'The SimpleFIN Bridge isn’t answering right now',
        'Try again in a few minutes.',
        undefined,
        {},
        ext,
      );
  }
}
