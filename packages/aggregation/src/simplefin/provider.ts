// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ProviderError,
  type AggregationProvider,
  type ProviderAccount,
  type ProviderAccountError,
  type ProviderCapabilities,
  type ProviderSecret,
  type ProviderTransaction,
  type SyncPage,
  type SyncRequest,
} from '@fiscus/domain';
import { SimpleFinClient, type SimpleFinClientOptions } from './client.js';
import {
  simpleFinProviderAccount,
  simpleFinProviderBalance,
  simpleFinProviderTransaction,
  todayIn,
} from './mapping.js';
import type { SimpleFinAccountSet } from './schemas.js';

/** The id stored on a SimpleFIN connection (`connections.provider`). */
export const SIMPLEFIN_PROVIDER_ID = 'simplefin';

export const SIMPLEFIN_CAPABILITIES: ProviderCapabilities = {
  cursorSync: false,
  pendingLinks: false,
  updateModeReauth: false,
  webhooks: false,
  liabilities: false,
  // The Bridge refreshes about daily and allows about 24 requests a day (D10).
  minRefreshMs: 6 * 60 * 60_000,
  maxHistoryDays: 90,
};

const DAY_MS = 86_400_000;

export interface SimpleFinProviderOptions extends SimpleFinClientOptions {
  /** The window's end, and the default start; defaults to the system clock. */
  now?: () => Date;
}

/**
 * The SimpleFIN Bridge behind `AggregationProvider` (#91). The secret is a token's access URL;
 * it's given to a client for one request and never kept, logged or put in an error.
 *
 * - `sync` is one `window` page: every transaction from `since` (90 days back by default) to
 *   today, pending ones included, for the accounts the Bridge returned without an error. Ingest
 *   drops what's no longer there, which is how a pending transaction that posted under a new id
 *   goes away (SimpleFIN never reports removals). Accounts with an error are left out of the
 *   window, so what they had is kept, and listed in `accountErrors`.
 * - Accounts in a currency Fiscus doesn't keep (a custom currency's URL) are left out.
 * - `remove` does nothing at the Bridge, which has no way to end a token's access from here: its
 *   owner revokes it at the Bridge (D14), and Fiscus deletes the access URL.
 */
export class SimpleFinProvider implements AggregationProvider {
  readonly id = SIMPLEFIN_PROVIDER_ID;
  readonly capabilities = SIMPLEFIN_CAPABILITIES;
  readonly #options: SimpleFinProviderOptions;
  readonly #now: () => Date;

  constructor(options: SimpleFinProviderOptions = {}) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  #client(secret: ProviderSecret): SimpleFinClient {
    return new SimpleFinClient(secret, this.#options);
  }

  async listAccounts(secret: ProviderSecret): Promise<ProviderAccount[]> {
    const set = await this.#client(secret).accounts({ balancesOnly: true });
    failIfNothing(set);
    return set.accounts.flatMap((a) => simpleFinProviderAccount(a) ?? []);
  }

  async sync(secret: ProviderSecret, request: SyncRequest): Promise<SyncPage> {
    const timeZone = request.timeZone ?? 'UTC';
    const now = this.#now();
    const to = todayIn(now, timeZone);
    const from =
      request.since ??
      todayIn(new Date(now.getTime() - SIMPLEFIN_CAPABILITIES.maxHistoryDays * DAY_MS), timeZone);
    // A day early, since `from` is a date in the household's zone and start-date an instant:
    // anything dated before `from` is dropped below.
    const startDate = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000) - 86_400;
    const set = await this.#client(secret).accounts({ startDate, pending: true });
    failIfNothing(set);

    const broken = accountsWithErrors(set);
    const accounts: ProviderAccount[] = [];
    const added: ProviderTransaction[] = [];
    for (const a of set.accounts) {
      const account = simpleFinProviderAccount(a);
      if (!account) continue;
      accounts.push(account);
      if (broken.has(a.id)) continue;
      for (const t of a.transactions ?? []) {
        const mapped = simpleFinProviderTransaction(t, account, timeZone, to);
        if (!mapped) continue;
        const date = mapped.pending ? mapped.authorizedDate : mapped.postedDate!;
        if (date >= from && date <= to) added.push(mapped);
      }
    }
    const errors: ProviderAccountError[] = [...broken.keys()]
      .filter((id) => accounts.some((a) => a.providerAccountId === id))
      .sort()
      .map((id) => ({ providerAccountId: id, code: broken.get(id)! }));
    return {
      mode: 'window',
      added,
      modified: [],
      removed: [],
      window: {
        from,
        to,
        providerAccountIds: accounts
          .map((a) => a.providerAccountId)
          .filter((id) => !broken.has(id)),
      },
      accounts,
      balances: set.accounts.flatMap((a) => simpleFinProviderBalance(a) ?? []),
      nextCursor: null,
      hasMore: false,
      ...(errors.length ? { accountErrors: errors } : {}),
    };
  }

  async remove(): Promise<void> {
    // Nothing to call: see the class's comment.
  }
}

/** A code safe to store: the Bridge's `prefix.subcode`, nothing else. */
const safeCode = (code: string) =>
  /^[a-z]{1,10}(\.[a-z0-9_-]{1,40})*$/i.test(code) ? code : 'unknown';

/**
 * The accounts an `errlist` entry names, directly or through their connection (a sign-in at one
 * bank fails all its accounts), with the code.
 */
function accountsWithErrors(set: SimpleFinAccountSet): Map<string, string> {
  const broken = new Map<string, string>();
  for (const e of set.errlist) {
    const code = safeCode(e.code);
    for (const a of set.accounts) {
      if ((e.account_id && a.id === e.account_id) || (e.conn_id && a.conn_id === e.conn_id)) {
        if (!broken.has(a.id)) broken.set(a.id, code);
      }
    }
  }
  return broken;
}

/** No accounts and an error: the whole token failed (say, the Bridge's own trouble). */
function failIfNothing(set: SimpleFinAccountSet): void {
  if (set.accounts.length === 0 && set.errlist.length > 0) {
    throw new ProviderError('transient', { providerCode: safeCode(set.errlist[0]!.code) });
  }
}
