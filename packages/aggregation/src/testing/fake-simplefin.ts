// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProviderAccount, ProviderBalance, ProviderTransaction } from '@fiscus/domain';
import { riveraScenario, type ConformanceScenario } from './rivera.js';
import {
  startStubServer,
  type StubListen,
  type StubRequest,
  type StubResponse,
} from './stub-server.js';

// A fake SimpleFIN Bridge for tests (D17: nothing in the test suite reaches the real Bridge): the
// claim and accounts endpoints on a stub server, answering in SimpleFIN's own format (protocol
// v2: decimal strings, epoch seconds, positive = money in) from a scenario in Fiscus's terms, the
// Riveras' Harbor Credit Union by default. A setup token is claimed once, as at the Bridge, and
// every accounts request needs the access URL's Basic credentials.

export interface FakeSimpleFinOptions {
  scenario?: ConformanceScenario;
  /** The access URL's username: the Bridge's id for the token. Another token, another user. */
  user?: string;
  /** The URL clients reach it at, when not the one it listens on (the e2e stack's `plaid-stub`). */
  publicUrl?: string;
  listen?: StubListen;
}

/** An answer to fail with: an HTTP status, or a 200 with an `errlist` entry. */
export type FakeSimpleFinFailure =
  | { status: number; body?: string; headers?: Record<string, string> }
  | { errlist: { code: string; msg?: string; conn_id?: string; account_id?: string }[] };

export interface FakeSimpleFin {
  url: string;
  /** Hosts to allow a client to request: the stub's. */
  host: string;
  /** A setup token for this Bridge, claimable once. */
  setupToken: string;
  /** What claiming answers with. */
  accessUrl: string;
  requests: StubRequest[];
  /** Makes the scenario's next update visible, as new activity at the bank. */
  release(): void;
  /** The next `times` accounts requests fail with `failure`. */
  failNext(failure: FakeSimpleFinFailure, times?: number): void;
  close(): Promise<void>;
}

const PASSWORD = 'rivera-bridge-password';

/** A date as the Bridge sends a bare date: exactly midnight UTC. */
const epochOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;

/** Minor units as the decimal string SimpleFIN sends (USD, 2 decimals). */
const decimal = (minor: number) => {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export function simpleFinAccount(
  account: ProviderAccount,
  balance: ProviderBalance | undefined,
  transactions: ProviderTransaction[],
) {
  return {
    org: { domain: 'harborcu.example', name: 'Harbor Credit Union' },
    id: account.providerAccountId,
    name: account.name,
    conn_id: 'conn-harbor',
    currency: account.currency,
    balance: decimal(balance?.currentMinor ?? 0),
    ...(balance?.availableMinor !== undefined
      ? { 'available-balance': decimal(balance.availableMinor) }
      : {}),
    'balance-date': Math.floor(Date.parse(balance?.asOf ?? '2026-10-20T00:00:00Z') / 1000),
    transactions: transactions.map(simpleFinTransaction),
  };
}

export function simpleFinTransaction(t: ProviderTransaction) {
  return {
    id: t.providerTransactionId,
    posted: t.pending || !t.postedDate ? 0 : epochOf(t.postedDate),
    amount: decimal(t.amountMinor),
    description: t.description,
    transacted_at: epochOf(t.authorizedDate),
    ...(t.pending ? { pending: true } : {}),
  };
}

export async function startFakeSimpleFin(
  options: FakeSimpleFinOptions = {},
): Promise<FakeSimpleFin> {
  const scenario = options.scenario ?? riveraScenario();
  const USER = options.user ?? 'rivera-bridge-user';
  let released = 1;
  let claimed = false;
  const failures: FakeSimpleFinFailure[] = [];
  const balances = new Map(scenario.balances.map((b) => [b.providerAccountId, b]));

  /** The bank's transactions once the released updates have happened. */
  const transactions = (): ProviderTransaction[] => {
    const store = new Map<string, ProviderTransaction>();
    for (const page of scenario.updates.slice(0, released).flat()) {
      for (const t of [...(page.added ?? []), ...(page.modified ?? [])]) {
        store.set(`${t.providerAccountId}/${t.providerTransactionId}`, t);
      }
      for (const r of page.removed ?? []) {
        store.delete(`${r.providerAccountId}/${r.providerTransactionId}`);
      }
    }
    return [...store.values()];
  };

  const authorized = (request: StubRequest) =>
    request.headers.authorization ===
    `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

  const accounts = (request: StubRequest): StubResponse => {
    if (!authorized(request)) return { status: 403, body: 'Forbidden' };
    const failure = failures.shift();
    if (failure && 'status' in failure) {
      return {
        status: failure.status,
        body: failure.body ?? '',
        ...(failure.headers ? { headers: failure.headers } : {}),
      };
    }
    const start = Number(request.query.get('start-date') ?? 0);
    const withPending = request.query.get('pending') === '1';
    const balancesOnly = request.query.get('balances-only') === '1';
    const all = transactions().filter((t) => {
      if (t.pending && !withPending) return false;
      return epochOf(t.pending ? t.authorizedDate : t.postedDate!) >= start;
    });
    return {
      body: {
        errlist: failure && 'errlist' in failure ? failure.errlist : [],
        connections: [{ conn_id: 'conn-harbor', name: 'Harbor Credit Union', org_id: 'harbor' }],
        accounts: scenario.accounts.map((a) =>
          simpleFinAccount(
            a,
            balances.get(a.providerAccountId),
            balancesOnly ? [] : all.filter((t) => t.providerAccountId === a.providerAccountId),
          ),
        ),
      },
    };
  };

  const server = await startStubServer({}, options.listen);
  const base = new URL(options.publicUrl ?? server.url);
  const accessUrl = `${base.protocol}//${USER}:${PASSWORD}@${base.host}/simplefin`;
  server.route('POST /claim/rivera-setup', () => {
    if (claimed) return { status: 403, body: 'Forbidden' };
    claimed = true;
    return { body: accessUrl };
  });
  server.route('GET /simplefin/accounts', accounts);

  return {
    url: server.url,
    host: base.hostname,
    setupToken: Buffer.from(`${base.origin}/claim/rivera-setup`).toString('base64'),
    accessUrl,
    requests: server.requests,
    release() {
      if (released >= scenario.updates.length) throw new Error('No more updates to release');
      released++;
    },
    failNext(failure, times = 1) {
      for (let i = 0; i < times; i++) failures.push(failure);
    },
    close: () => server.close(),
  };
}
