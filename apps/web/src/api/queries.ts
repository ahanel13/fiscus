// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AccountLayout,
  AuthStatus,
  BalancePoint,
  BankConnectionsOverview,
  CashFlow,
  CategoryGroup,
  Connection,
  ConnectionSetup,
  HouseholdPlaidKeys,
  Household,
  HouseholdMember,
  ImportBatch,
  ImportProfile,
  InvitePreview,
  Lens,
  Me,
  NetWorth,
  PlaidAvailability,
  PossibleDuplicate,
  ReviewCount,
  SimpleFinAvailability,
  ServerInvite,
  ServerInvitePreview,
  SessionSummary,
  Tag,
  Transaction,
  TransactionHistoryEntry,
  TransactionSort,
  TransferReview,
} from '@fiscus/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api } from './client.js';

type Data<T> = { data: T };

export const authStatusQuery = queryOptions({
  queryKey: ['auth', 'status'],
  queryFn: async () => (await api<Data<AuthStatus>>('GET', '/api/v1/auth/status')).data,
});

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => (await api<Data<Me>>('GET', '/api/v1/me')).data,
  staleTime: 30_000,
});

export const householdQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id],
    queryFn: async () => (await api<Data<Household>>('GET', `/api/v1/households/${id}`)).data,
  });

export const membersQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'members'],
    queryFn: async () =>
      (await api<Data<HouseholdMember[]>>('GET', `/api/v1/households/${id}/members`)).data,
  });

export const sessionsQuery = queryOptions({
  queryKey: ['me', 'sessions'],
  queryFn: async () => (await api<Data<SessionSummary[]>>('GET', '/api/v1/me/sessions')).data,
});

export const lookupInvite = async (token: string) =>
  (await api<Data<InvitePreview>>('POST', '/api/v1/invites/lookup', { body: { token } })).data;

export const lookupServerInvite = async (token: string) =>
  (await api<Data<ServerInvitePreview>>('POST', '/api/v1/auth/join/lookup', { body: { token } }))
    .data;

/** Server invites not yet used (instance admins, ADM-08). */
export const serverInvitesQuery = queryOptions({
  queryKey: ['admin', 'invites'],
  queryFn: async () => (await api<Data<ServerInvite[]>>('GET', '/api/v1/admin/invites')).data,
});

/** Server → Bank connections: Plaid's status and the bank settings (instance admins, #400). */
export const bankConnectionsQuery = queryOptions({
  queryKey: ['admin', 'bank-connections'],
  queryFn: async () =>
    (await api<Data<BankConnectionsOverview>>('GET', '/api/v1/admin/bank-connections')).data,
});

const hh = (id: string) => `/api/v1/households/${id}`;

/** Whether "Connect a bank" can use Plaid in this household (#79); owners and members only. */
export const plaidAvailabilityQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'plaid'],
    queryFn: async () => (await api<Data<PlaidAvailability>>('GET', `${hh(id)}/plaid`)).data,
    staleTime: 60_000,
  });

/** Whether the server's admin has SimpleFIN on (#91). */
export const simpleFinAvailabilityQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'simplefin'],
    queryFn: async () =>
      (await api<Data<SimpleFinAvailability>>('GET', `${hh(id)}/simplefin`)).data,
    staleTime: 60_000,
  });

/**
 * The bank connections behind the accounts you see, and your own (ACC-02, #81). While one is due
 * (just refreshed or signed in again), asked again every few seconds, so its sync shows up.
 */
export const connectionsQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'connections'],
    queryFn: async () => (await api<Data<Connection[]>>('GET', `${hh(id)}/connections`)).data,
    refetchInterval: (q) =>
      q.state.data?.some(
        (c) =>
          (c.status === 'ok' || c.status === 'error') &&
          c.nextSyncAt &&
          Date.parse(c.nextSyncAt) <= Date.now(),
      )
        ? 5_000
        : 60_000,
  });

/** The household's own Plaid keys, as far as they're shown, for its owners (#83, HH-08). */
export const plaidKeysQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'plaid-credentials'],
    queryFn: async () =>
      (await api<Data<HouseholdPlaidKeys>>('GET', `${hh(id)}/plaid-credentials`)).data,
  });

/** A connection being set up: what the bank offers, again, after a reload (#79, D4). */
export const connectionSetupQuery = (id: string, connectionId: string) =>
  queryOptions({
    queryKey: ['households', id, 'connections', connectionId, 'setup'],
    queryFn: async () =>
      (await api<Data<ConnectionSetup>>('GET', `${hh(id)}/connections/${connectionId}/setup`)).data,
    retry: false,
    staleTime: Infinity,
  });

/** With range parameters (rangeParams()), each account carries its change over the range (#353). */
/** Your own arrangement of the accounts list: groups and order (#48). */
export const accountLayoutQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'account-layout'],
    queryFn: async () => (await api<Data<AccountLayout>>('GET', `${hh(id)}/account-layout`)).data,
  });

export const accountsQuery = (
  id: string,
  lens: Lens,
  include: 'open' | 'closed' = 'open',
  range?: URLSearchParams,
) =>
  queryOptions({
    queryKey: ['households', id, 'accounts', { lens, include, range: range?.toString() ?? null }],
    queryFn: async () => {
      const params = new URLSearchParams(range);
      params.set('lens', lens);
      params.set('include', include);
      return (await api<Data<Account[]>>('GET', `${hh(id)}/accounts?${params}`)).data;
    },
  });

export const accountQuery = (id: string, accountId: string) =>
  queryOptions({
    queryKey: ['households', id, 'accounts', accountId],
    queryFn: async () => (await api<Data<Account>>('GET', `${hh(id)}/accounts/${accountId}`)).data,
  });

/** An account's balances: the last 365 days, or a range; `opening` leads with the balance in effect. */
export const balancesQuery = (
  id: string,
  accountId: string,
  range?: URLSearchParams,
  opening = false,
) =>
  queryOptions({
    queryKey: [
      'households',
      id,
      'accounts',
      accountId,
      'balances',
      { range: range?.toString() ?? null, opening },
    ],
    queryFn: async () => {
      const params = new URLSearchParams(range);
      if (opening) params.set('opening', 'true');
      return (
        await api<Data<BalancePoint[]>>('GET', `${hh(id)}/accounts/${accountId}/balances?${params}`)
      ).data;
    },
  });

export const netWorthQuery = (id: string, lens: Lens) =>
  queryOptions({
    queryKey: ['households', id, 'net-worth', { lens }],
    queryFn: async () =>
      (await api<Data<NetWorth>>('GET', `${hh(id)}/net-worth?lens=${encodeURIComponent(lens)}`))
        .data,
  });

export const categoriesQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'categories'],
    queryFn: async () => (await api<Data<CategoryGroup[]>>('GET', `${hh(id)}/categories`)).data,
    staleTime: 60_000,
  });

export const tagsQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'tags'],
    queryFn: async () => (await api<Data<Tag[]>>('GET', `${hh(id)}/tags`)).data,
    staleTime: 60_000,
  });

export interface TransactionFilters {
  lens: Lens;
  /** Range parameters (ADR 0011), from rangeParams(). */
  range?: string;
  accounts?: string[];
  categories?: string[];
  q?: string;
  review?: 'needs_review' | 'reviewed';
  /** Newest first unless `oldest` (the review queue). */
  order?: 'newest' | 'oldest';
  /** The table's sort (#351); `direction` overrides `order`. */
  sort?: TransactionSort;
  direction?: 'asc' | 'desc';
}

/** Pages of transactions, newest first unless sorted otherwise, by cursor. */
export const transactionsQuery = (id: string, filters: TransactionFilters) =>
  infiniteQueryOptions({
    queryKey: ['households', id, 'transactions', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams(filters.range ?? '');
      params.set('lens', filters.lens);
      params.set('limit', '50');
      if (filters.accounts?.length) params.set('accounts', filters.accounts.join(','));
      if (filters.categories?.length) params.set('categories', filters.categories.join(','));
      if (filters.q) params.set('q', filters.q);
      if (filters.review) params.set('review', filters.review);
      if (filters.order) params.set('order', filters.order);
      if (filters.sort) params.set('sort', filters.sort);
      if (filters.direction) params.set('direction', filters.direction);
      if (pageParam) params.set('cursor', pageParam);
      return api<{ data: Transaction[]; meta: { nextCursor: string | null } }>(
        'GET',
        `${hh(id)}/transactions?${params}`,
      );
    },
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });

/** What waits for you in the review queue (#44): the badge on Transactions. */
export const reviewCountQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'transactions', 'review-count'],
    queryFn: async () =>
      (await api<Data<ReviewCount>>('GET', `${hh(id)}/transactions/review-count`)).data,
    staleTime: 30_000,
  });

/** Synced transactions that may be ones already here, in accounts you own (#80, D7). */
export const possibleDuplicatesQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'transactions', 'possible-duplicates'],
    queryFn: async () =>
      (await api<Data<PossibleDuplicate[]>>('GET', `${hh(id)}/transactions/possible-duplicates`))
        .data,
  });

/** Suggested transfer pairs, and transfers with no other side (transfers.md §2). */
export const transferReviewQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'transactions', 'transfer-review'],
    queryFn: async () =>
      (await api<Data<TransferReview>>('GET', `${hh(id)}/transactions/transfer-review`)).data,
  });

export const transactionQuery = (id: string, transactionId: string) =>
  queryOptions({
    queryKey: ['households', id, 'transactions', 'one', transactionId],
    queryFn: async () =>
      (await api<Data<Transaction>>('GET', `${hh(id)}/transactions/${transactionId}`)).data,
  });

/** A transaction's history, newest first (TXN-11). Refreshed with the ledger after each change. */
export const transactionHistoryQuery = (id: string, transactionId: string) =>
  queryOptions({
    queryKey: ['households', id, 'transactions', 'history', transactionId],
    queryFn: async () =>
      (
        await api<Data<TransactionHistoryEntry[]>>(
          'GET',
          `${hh(id)}/transactions/${transactionId}/history`,
        )
      ).data,
  });

export const preferencesQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'preferences'],
    queryFn: async () =>
      (await api<Data<Record<string, unknown>>>('GET', `${hh(id)}/preferences`)).data,
    staleTime: 5 * 60_000,
  });

export const cashFlowQuery = (id: string, lens: Lens, params: URLSearchParams) =>
  queryOptions({
    queryKey: ['households', id, 'cash-flow', { lens, params: params.toString() }],
    queryFn: async () =>
      (
        await api<Data<CashFlow>>(
          'GET',
          `${hh(id)}/cash-flow?lens=${encodeURIComponent(lens)}&${params}`,
        )
      ).data,
  });

export const netWorthRangeQuery = (id: string, lens: Lens, params: URLSearchParams) =>
  queryOptions({
    queryKey: ['households', id, 'net-worth', { lens, params: params.toString() }],
    queryFn: async () =>
      (
        await api<Data<NetWorth>>(
          'GET',
          `${hh(id)}/net-worth?lens=${encodeURIComponent(lens)}&${params}`,
        )
      ).data,
  });

export const importProfilesQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'import-profiles'],
    queryFn: async () =>
      (await api<Data<ImportProfile[]>>('GET', `${hh(id)}/import-profiles`)).data,
  });

export const importsQuery = (id: string) =>
  queryOptions({
    queryKey: ['households', id, 'imports'],
    queryFn: async () => (await api<Data<ImportBatch[]>>('GET', `${hh(id)}/imports`)).data,
  });

/** How earlier imports mapped category names (lower-cased name → category id). */
export const importCategoryMapQuery = (id: string, format: 'csv' | 'monarch') =>
  queryOptions({
    queryKey: ['households', id, 'imports', 'category-map', format],
    queryFn: async () =>
      (
        await api<Data<Record<string, string>>>(
          'GET',
          `${hh(id)}/imports/category-map?format=${format}`,
        )
      ).data,
  });
