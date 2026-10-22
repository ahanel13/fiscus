// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isProviderError,
  type AggregationProvider,
  type ProviderAccount,
  type ProviderErrorKind,
  type ProviderSecret,
  type ProviderTransaction,
  type SyncPage,
  type SyncRequest,
} from '@fiscus/domain';
import { describe, expect, it } from 'vitest';
import { transactionDate } from './fake-provider.js';
import { riveraScenario, type ConformanceScenario } from './rivera.js';

/** What the suite asks an adapter's test harness to set up. */
export interface ConformanceSetup {
  scenario: ConformanceScenario;
  /**
   * Make one call to `sync` (counting from 0) fail, once, with the provider's own error for
   * `kind`, carrying `providerMessage` as the provider's message.
   */
  fail?: { onSync: number; kind: ProviderErrorKind; providerMessage: string };
}

/**
 * A provider serving the scenario, usually an adapter pointed at a stub server that answers in
 * the provider's own format. Only the scenario's first update is visible at first.
 */
export interface ConformanceHarness {
  provider: AggregationProvider;
  secret: ProviderSecret;
  /** Makes the scenario's next update visible, as new activity at the bank. */
  release(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface ConformanceOptions {
  /** The error kinds the provider can report; each is checked. */
  errorKinds: readonly ProviderErrorKind[];
  /** Fields the provider never reports (SimpleFIN has no merchant names), left out of comparisons. */
  unsupportedFields?: readonly (keyof ProviderTransaction)[];
  /** Account fields the provider never reports (Plaid doesn't say an account is closed). */
  unsupportedAccountFields?: readonly (keyof ProviderAccount)[];
  /** Defaults to the Riveras' Harbor Credit Union. */
  scenario?: () => ConformanceScenario;
}

const MAX_PAGES = 100;
const UNTRUSTED_MESSAGE = 'Alex Rivera, please <b>sign in</b> again at Harbor Credit Union';

type Store = Map<string, ProviderTransaction>;

const key = (t: { providerAccountId: string; providerTransactionId: string }) =>
  `${t.providerAccountId}\u0000${t.providerTransactionId}`;

/** What a page means to the ledger: delta pages apply in order, a window replaces its range. */
export function applyPage(store: Store, page: SyncPage): void {
  if (page.mode === 'window' && page.window) {
    const { from, to, providerAccountIds } = page.window;
    for (const [k, t] of store) {
      const date = transactionDate(t);
      if (providerAccountIds.includes(t.providerAccountId) && date >= from && date <= to) {
        store.delete(k);
      }
    }
  }
  for (const t of [...page.added, ...page.modified]) store.set(key(t), t);
  for (const r of page.removed) store.delete(key(r));
}

/** The bank's transactions once the first `released` updates have happened. */
function expectedState(scenario: ConformanceScenario, released: number): Store {
  const store: Store = new Map();
  for (const update of scenario.updates.slice(0, released)) {
    for (const page of update) {
      applyPage(store, {
        mode: 'delta',
        added: page.added ?? [],
        modified: page.modified ?? [],
        removed: page.removed ?? [],
        nextCursor: null,
        hasMore: false,
      });
    }
  }
  return store;
}

interface Run {
  requests: { request: SyncRequest; page: SyncPage }[];
  cursor: string | null;
}

/** Follows `nextCursor` until `hasMore` is false, as the sync worker does. */
async function syncAll(
  harness: ConformanceHarness,
  since: string,
  cursor: string | null,
): Promise<Run> {
  const requests: Run['requests'] = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const request = { cursor, since };
    const page = await harness.provider.sync(harness.secret, request);
    requests.push({ request, page });
    cursor = page.nextCursor;
    if (!page.hasMore) return { requests, cursor };
  }
  throw new Error(`sync still had more after ${MAX_PAGES} pages`);
}

/**
 * The checks every `AggregationProvider` adapter passes (#78): sign normalization, idempotent
 * pages, `window` and `delta` semantics, error kinds, `hasMore`/`nextCursor` consistency, and
 * pending links where the provider has them. Call it at the top level of a test file.
 */
export function describeProviderConformance(
  name: string,
  create: (setup: ConformanceSetup) => Promise<ConformanceHarness> | ConformanceHarness,
  options: ConformanceOptions,
): void {
  const scenarioOf = options.scenario ?? riveraScenario;

  const withHarness = async <T>(
    setup: Partial<ConformanceSetup>,
    run: (harness: ConformanceHarness, scenario: ConformanceScenario) => Promise<T>,
  ): Promise<T> => {
    const scenario = setup.scenario ?? scenarioOf();
    const harness = await create({ ...setup, scenario });
    try {
      return await run(harness, scenario);
    } finally {
      await harness.close?.();
    }
  };

  /** Comparable rows: sorted, without the fields the provider can't report. */
  const rows = (store: Store, pendingLinks: boolean) => {
    const omit = new Set<string>(options.unsupportedFields ?? []);
    if (!pendingLinks) omit.add('pendingTransactionId');
    return [...store.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, t]) => Object.fromEntries(Object.entries(t).filter(([field]) => !omit.has(field))));
  };

  /** Syncs after each update, checking the ledger matches the bank every time. */
  const syncEveryUpdate = (harness: ConformanceHarness, scenario: ConformanceScenario) => {
    const store: Store = new Map();
    const runs: Run[] = [];
    return (async () => {
      let cursor: string | null = null;
      for (let released = 1; released <= scenario.updates.length; released++) {
        if (released > 1) await harness.release();
        const run = await syncAll(harness, scenario.since, cursor);
        for (const { page } of run.requests) applyPage(store, page);
        runs.push(run);
        cursor = run.cursor;
        const pendingLinks = harness.provider.capabilities.pendingLinks;
        expect(rows(store, pendingLinks), `after update ${released}`).toEqual(
          rows(expectedState(scenario, released), pendingLinks),
        );
      }
      return { store, runs, cursor };
    })();
  };

  describe(`${name}: provider conformance`, () => {
    it('declares consistent capabilities', () =>
      withHarness({}, async ({ provider }) => {
        const c = provider.capabilities;
        for (const flag of [
          'cursorSync',
          'pendingLinks',
          'updateModeReauth',
          'webhooks',
          'liabilities',
        ] as const) {
          expect(typeof c[flag], flag).toBe('boolean');
        }
        for (const limit of ['minRefreshMs', 'maxHistoryDays'] as const) {
          expect(Number.isSafeInteger(c[limit]) && c[limit] > 0, limit).toBe(true);
        }
        expect(typeof provider.id).toBe('string');
        expect(provider.id).not.toBe('');
        expect(typeof provider.liabilities === 'function').toBe(c.liabilities);
      }));

    it('lists the accounts', () =>
      withHarness({}, async ({ provider, secret }, scenario) => {
        const accounts = await provider.listAccounts(secret);
        const byId = (a: { providerAccountId: string }, b: { providerAccountId: string }) =>
          a.providerAccountId.localeCompare(b.providerAccountId);
        const omit = new Set<string>(options.unsupportedAccountFields ?? []);
        const comparable = (list: ProviderAccount[]) =>
          [...list]
            .sort(byId)
            .map((a) => Object.fromEntries(Object.entries(a).filter(([f]) => !omit.has(f))));
        expect(comparable(accounts)).toEqual(comparable(scenario.accounts));
      }));

    it("converges on the bank's transactions after every update", () =>
      withHarness({}, async (harness, scenario) => {
        await syncEveryUpdate(harness, scenario);
      }));

    it("reports amounts and balances in Fiscus's sign: money out is negative", () =>
      withHarness({}, async (harness, scenario) => {
        const { store, runs } = await syncEveryUpdate(harness, scenario);
        const expected = expectedState(scenario, scenario.updates.length);
        expect(
          [...expected.values()].some((t) => t.amountMinor < 0) &&
            [...expected.values()].some((t) => t.amountMinor > 0),
          'the scenario has money in and money out',
        ).toBe(true);
        for (const [k, t] of expected) {
          const actual = store.get(k);
          expect(actual?.amountMinor, t.providerTransactionId).toBe(t.amountMinor);
          if (!options.unsupportedFields?.includes('foreignAmountMinor')) {
            expect(actual?.foreignAmountMinor, t.providerTransactionId).toBe(t.foreignAmountMinor);
          }
        }
        const last = runs.at(-1)!.requests.at(-1)!.page;
        if (last.balances) {
          const byId = new Map(last.balances.map((b) => [b.providerAccountId, b]));
          for (const balance of scenario.balances) {
            expect(byId.get(balance.providerAccountId), balance.providerAccountId).toEqual(balance);
          }
        }
      }));

    it('returns the same page for the same request', () =>
      withHarness({}, async (harness, scenario) => {
        const run = await syncAll(harness, scenario.since, null);
        for (const { request, page } of run.requests) {
          expect(await harness.provider.sync(harness.secret, request)).toEqual(page);
        }
      }));

    it('keeps hasMore and nextCursor consistent', () =>
      withHarness({}, async (harness, scenario) => {
        const { runs, cursor } = await syncEveryUpdate(harness, scenario);
        for (const { request, page } of runs.flatMap((r) => r.requests)) {
          if (page.mode === 'delta') expect(page.nextCursor).not.toBeNull();
          if (page.hasMore) {
            expect(page.nextCursor).not.toBeNull();
            expect(page.nextCursor).not.toBe(request.cursor);
          }
        }
        // Nothing new at the bank: nothing changes, and there's nothing more.
        const quiet = await harness.provider.sync(harness.secret, {
          cursor,
          since: scenario.since,
        });
        expect(quiet.hasMore).toBe(false);
        if (quiet.mode === 'delta') {
          expect([quiet.added, quiet.modified, quiet.removed]).toEqual([[], [], []]);
          expect(quiet.nextCursor).toBe(cursor);
        }
      }));

    it('follows its mode: delta with a cursor, otherwise everything in a window', () =>
      withHarness({}, async (harness, scenario) => {
        const { runs } = await syncEveryUpdate(harness, scenario);
        const accountIds = scenario.accounts.map((a) => a.providerAccountId);
        const { cursorSync } = harness.provider.capabilities;
        for (const { page } of runs.flatMap((r) => r.requests)) {
          expect(page.mode).toBe(cursorSync ? 'delta' : 'window');
          if (page.mode === 'delta') {
            expect(page.window).toBeUndefined();
            continue;
          }
          expect(page.window).toBeDefined();
          const { from, to, providerAccountIds } = page.window!;
          expect(from <= to).toBe(true);
          expect(page.modified).toEqual([]);
          expect(page.removed).toEqual([]);
          for (const id of providerAccountIds) expect(accountIds).toContain(id);
          for (const t of page.added) {
            expect(providerAccountIds).toContain(t.providerAccountId);
            const date = transactionDate(t);
            expect(date >= from && date <= to, t.providerTransactionId).toBe(true);
          }
        }
      }));

    it('dates pending and posted transactions, and links them where it can', () =>
      withHarness({}, async (harness, scenario) => {
        const { store } = await syncEveryUpdate(harness, scenario);
        for (const t of store.values()) {
          if (t.pending) expect(t.postedDate, t.providerTransactionId).toBeUndefined();
          else expect(t.postedDate, t.providerTransactionId).toBeDefined();
        }
        const pairs = [...expectedState(scenario, scenario.updates.length).values()].filter(
          (t) => t.pendingTransactionId,
        );
        expect(pairs.length, 'the scenario has a pending → posted pair').toBeGreaterThan(0);
        if (harness.provider.capabilities.pendingLinks) {
          for (const posted of pairs) {
            expect(store.get(key(posted))?.pendingTransactionId).toBe(posted.pendingTransactionId);
            expect(
              store.has(
                key({
                  providerAccountId: posted.providerAccountId,
                  providerTransactionId: posted.pendingTransactionId!,
                }),
              ),
            ).toBe(false);
          }
        } else {
          for (const t of store.values()) expect(t.pendingTransactionId).toBeUndefined();
        }
      }));

    for (const kind of options.errorKinds) {
      it(`reports ${kind} as a ProviderError, and a retry gets the page`, async () => {
        const fail = { onSync: 1, kind, providerMessage: UNTRUSTED_MESSAGE };
        const expected = await withHarness({}, async (harness, scenario) => {
          const first = await harness.provider.sync(harness.secret, {
            cursor: null,
            since: scenario.since,
          });
          return harness.provider.sync(harness.secret, {
            cursor: first.nextCursor,
            since: scenario.since,
          });
        });
        await withHarness({ fail }, async (harness, scenario) => {
          const first = await harness.provider.sync(harness.secret, {
            cursor: null,
            since: scenario.since,
          });
          const request = { cursor: first.nextCursor, since: scenario.since };
          const error: unknown = await harness.provider.sync(harness.secret, request).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(isProviderError(error), String(error)).toBe(true);
          if (!isProviderError(error)) return;
          expect(error.kind).toBe(kind);
          expect(typeof error.providerCode).toBe('string');
          expect(error.providerCode).not.toBe('');
          if (error.retryAfterMs !== undefined) {
            expect(Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0).toBe(true);
          }
          // The provider's message is display text only: never in what gets logged.
          expect(error.message).not.toContain('Harbor');
          expect(JSON.stringify(error)).not.toContain('Harbor');
          expect(await harness.provider.sync(harness.secret, request)).toEqual(expected);
        });
      });
    }

    it('lists liabilities when it has them', () =>
      withHarness({}, async ({ provider, secret }, scenario) => {
        if (!provider.capabilities.liabilities) {
          expect(provider.liabilities).toBeUndefined();
          return;
        }
        const liabilities = await provider.liabilities!(secret);
        expect(liabilities).toEqual(scenario.liabilities);
      }));

    it('refreshes and removes the connection', () =>
      withHarness({}, async ({ provider, secret }) => {
        if (provider.refresh) await provider.refresh(secret);
        await expect(provider.remove(secret)).resolves.toBeUndefined();
      }));
  });
}
