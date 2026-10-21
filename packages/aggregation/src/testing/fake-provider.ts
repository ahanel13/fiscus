// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ProviderError,
  type AggregationProvider,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderCapabilities,
  type ProviderErrorKind,
  type ProviderLiability,
  type ProviderRemovedTransaction,
  type ProviderSecret,
  type ProviderTransaction,
  type SyncPage,
  type SyncRequest,
} from '@fiscus/domain';

const DAY_MS = 86_400_000;

/** A clock the test moves by hand. */
export class FakeClock {
  #now: number;

  constructor(start: string | Date) {
    this.#now = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.#now);
  }

  /** Today in UTC, as `YYYY-MM-DD`. */
  today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  set(to: string | Date): void {
    this.#now = new Date(to).getTime();
  }
}

/** One page of a scripted update, in Fiscus's terms. */
export interface ScriptedPage {
  added?: ProviderTransaction[];
  modified?: ProviderTransaction[];
  removed?: ProviderRemovedTransaction[];
  historicalComplete?: boolean;
}

export interface ScriptedError {
  /** The call to `sync` that fails, counting from 0. In a straight run, call N asks for page N. */
  onSync: number;
  kind: ProviderErrorKind;
  providerCode?: string;
  retryAfterMs?: number;
  providerMessage?: string;
}

export interface FakeScript {
  /** Defaults to `fake`. */
  id?: string;
  /** `delta` behaves like Plaid, `window` like SimpleFIN; the capabilities default to match. */
  mode: 'delta' | 'window';
  capabilities?: Partial<ProviderCapabilities>;
  /** The only secret accepted. Defaults to `fake-secret`. */
  secret?: string;
  accounts: ProviderAccount[];
  balances?: ProviderBalance[];
  liabilities?: ProviderLiability[];
  /**
   * What happens at the bank, in order. Each update is the pages one sync returns, and a sync
   * sees only released updates: the first, until `release()` is called.
   */
  updates: ScriptedPage[][];
  /** How many updates are visible from the start. Defaults to 1. */
  released?: number;
  /** Each fails once. */
  errors?: ScriptedError[];
  clock?: FakeClock;
}

export type FakeCall =
  | { method: 'sync'; request: SyncRequest }
  | { method: 'listAccounts' | 'refresh' | 'liabilities' | 'remove' };

const DELTA_CAPABILITIES: ProviderCapabilities = {
  cursorSync: true,
  pendingLinks: true,
  updateModeReauth: true,
  webhooks: true,
  liabilities: true,
  minRefreshMs: 15 * 60_000,
  maxHistoryDays: 730,
};

const WINDOW_CAPABILITIES: ProviderCapabilities = {
  cursorSync: false,
  pendingLinks: false,
  updateModeReauth: false,
  webhooks: false,
  liabilities: false,
  minRefreshMs: 6 * 60 * 60_000,
  maxHistoryDays: 90,
};

interface Position {
  update: number;
  page: number;
}

const transactionKey = (t: { providerAccountId: string; providerTransactionId: string }) =>
  `${t.providerAccountId}\u0000${t.providerTransactionId}`;

export const transactionDate = (t: ProviderTransaction) => t.postedDate ?? t.authorizedDate;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * A scripted, deterministic provider for tests: accounts, ordered pages in `delta` or `window`
 * mode, errors on chosen calls, pending → posted pairs, and a clock. It is the reference the
 * conformance suite is checked against.
 */
export class FakeAggregationProvider implements AggregationProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly clock: FakeClock;
  /** Every call made, in order (secrets left out). */
  readonly calls: FakeCall[] = [];
  readonly liabilities?: (secret: ProviderSecret) => Promise<ProviderLiability[]>;

  readonly #script: FakeScript;
  readonly #updates: ScriptedPage[][];
  readonly #secret: string;
  readonly #errors: ScriptedError[];
  #released: number;
  #syncCalls = 0;
  #lastRefreshAt: number | undefined;
  #removed = false;

  constructor(script: FakeScript) {
    this.#script = structuredClone({ ...script, clock: undefined });
    this.id = script.id ?? 'fake';
    this.capabilities = {
      ...(script.mode === 'delta' ? DELTA_CAPABILITIES : WINDOW_CAPABILITIES),
      ...script.capabilities,
    };
    if (script.mode === 'delta' && !this.capabilities.cursorSync) {
      throw new Error('A delta-mode fake needs cursorSync');
    }
    this.clock = script.clock ?? new FakeClock('2026-10-20T12:00:00Z');
    this.#updates = this.#script.updates;
    if (this.#updates.some((update) => update.length === 0)) {
      throw new Error('Every scripted update needs at least one page');
    }
    this.#secret = script.secret ?? 'fake-secret';
    this.#errors = [...(this.#script.errors ?? [])];
    this.#released = Math.min(script.released ?? 1, this.#updates.length);
    if (this.capabilities.liabilities) {
      this.liabilities = async (secret) => {
        this.calls.push({ method: 'liabilities' });
        this.#check(secret);
        return structuredClone(this.#script.liabilities ?? []);
      };
    }
  }

  /** Makes the next `count` updates visible to sync, as if the bank had new activity. */
  release(count = 1): void {
    if (this.#released + count > this.#updates.length) {
      throw new Error('No more scripted updates to release');
    }
    this.#released += count;
  }

  /** Adds an update to the end of the script; `release()` makes it visible. */
  push(update: ScriptedPage[]): void {
    if (update.length === 0) throw new Error('An update needs at least one page');
    this.#updates.push(structuredClone(update));
  }

  async listAccounts(secret: ProviderSecret): Promise<ProviderAccount[]> {
    this.calls.push({ method: 'listAccounts' });
    this.#check(secret);
    return structuredClone(this.#script.accounts);
  }

  async sync(secret: ProviderSecret, request: SyncRequest): Promise<SyncPage> {
    this.calls.push({ method: 'sync', request: { ...request } });
    const call = this.#syncCalls++;
    this.#check(secret);
    const failure = this.#errors.findIndex((e) => e.onSync === call);
    if (failure !== -1) {
      const [e] = this.#errors.splice(failure, 1);
      throw new ProviderError(e!.kind, {
        providerCode: e!.providerCode ?? `FAKE_${e!.kind.toUpperCase()}`,
        retryAfterMs: e!.retryAfterMs,
        providerMessage: e!.providerMessage,
      });
    }
    return this.#script.mode === 'delta' ? this.#delta(request) : this.#window(request);
  }

  async refresh(secret: ProviderSecret): Promise<void> {
    this.calls.push({ method: 'refresh' });
    this.#check(secret);
    const now = this.clock.now().getTime();
    const wait =
      this.#lastRefreshAt === undefined
        ? 0
        : this.#lastRefreshAt + this.capabilities.minRefreshMs - now;
    if (wait > 0) {
      throw new ProviderError('rate_limited', {
        providerCode: 'FAKE_RATE_LIMITED',
        retryAfterMs: wait,
      });
    }
    this.#lastRefreshAt = now;
  }

  async remove(secret: ProviderSecret): Promise<void> {
    this.calls.push({ method: 'remove' });
    this.#check(secret);
    this.#removed = true;
  }

  #check(secret: ProviderSecret): void {
    if (this.#removed) {
      throw new ProviderError('invalid_credentials', { providerCode: 'FAKE_ITEM_REMOVED' });
    }
    if (secret !== this.#secret) {
      throw new ProviderError('invalid_credentials', { providerCode: 'FAKE_INVALID_SECRET' });
    }
  }

  #delta(request: SyncRequest): SyncPage {
    const at = request.cursor === null ? { update: 0, page: 0 } : parseCursor(request.cursor);
    const base = {
      mode: 'delta' as const,
      accounts: structuredClone(this.#script.accounts),
      balances: structuredClone(this.#script.balances ?? []),
    };
    if (at.update >= this.#released) {
      // Nothing new at the bank: an empty page that keeps the cursor where it is.
      return {
        ...base,
        added: [],
        modified: [],
        removed: [],
        nextCursor: formatCursor(at),
        hasMore: false,
      };
    }
    const update = this.#updates[at.update];
    const page = update?.[at.page];
    if (!page) throw new RangeError(`Unknown cursor: ${request.cursor}`);
    const next =
      at.page + 1 < update!.length
        ? { update: at.update, page: at.page + 1 }
        : { update: at.update + 1, page: 0 };
    return {
      ...base,
      added: this.#links(page.added ?? []),
      modified: this.#links(page.modified ?? []),
      removed: structuredClone(page.removed ?? []),
      nextCursor: formatCursor(next),
      hasMore: next.update < this.#released,
      ...(page.historicalComplete !== undefined && {
        historicalComplete: page.historicalComplete,
      }),
    };
  }

  #window(request: SyncRequest): SyncPage {
    const state = new Map<string, ProviderTransaction>();
    for (const update of this.#updates.slice(0, this.#released)) {
      for (const page of update) {
        for (const t of [...(page.added ?? []), ...(page.modified ?? [])]) {
          state.set(transactionKey(t), t);
        }
        for (const r of page.removed ?? []) state.delete(transactionKey(r));
      }
    }
    const to = this.clock.today();
    const earliest = addDays(to, -this.capabilities.maxHistoryDays);
    const from = request.since && request.since > earliest ? request.since : earliest;
    const providerAccountIds = this.#script.accounts.map((a) => a.providerAccountId);
    const added = [...state.values()]
      .filter((t) => transactionDate(t) >= from && transactionDate(t) <= to)
      .filter((t) => providerAccountIds.includes(t.providerAccountId))
      .sort(
        (a, b) =>
          transactionDate(a).localeCompare(transactionDate(b)) ||
          transactionKey(a).localeCompare(transactionKey(b)),
      );
    return {
      mode: 'window',
      added: this.#links(added),
      modified: [],
      removed: [],
      window: { from, to, providerAccountIds },
      accounts: structuredClone(this.#script.accounts),
      balances: structuredClone(this.#script.balances ?? []),
      nextCursor: null,
      hasMore: false,
    };
  }

  /** Copies, without pending links when the provider can't make them. */
  #links(transactions: ProviderTransaction[]): ProviderTransaction[] {
    return transactions.map((t) => {
      const copy = structuredClone(t);
      if (!this.capabilities.pendingLinks) delete copy.pendingTransactionId;
      return copy;
    });
  }
}

const formatCursor = (at: Position) => `fake:${at.update}:${at.page}`;

function parseCursor(cursor: string): Position {
  const match = /^fake:(\d+):(\d+)$/.exec(cursor);
  if (!match) throw new RangeError(`Unknown cursor: ${cursor}`);
  return { update: Number(match[1]), page: Number(match[2]) };
}
