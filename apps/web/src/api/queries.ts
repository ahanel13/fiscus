// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AuthStatus,
  BalancePoint,
  CategoryGroup,
  Household,
  HouseholdMember,
  InvitePreview,
  Lens,
  Me,
  NetWorth,
  SessionSummary,
  Tag,
  Transaction,
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

const hh = (id: string) => `/api/v1/households/${id}`;

export const accountsQuery = (id: string, lens: Lens, include: 'open' | 'closed' = 'open') =>
  queryOptions({
    queryKey: ['households', id, 'accounts', { lens, include }],
    queryFn: async () =>
      (
        await api<Data<Account[]>>(
          'GET',
          `${hh(id)}/accounts?lens=${encodeURIComponent(lens)}&include=${include}`,
        )
      ).data,
  });

export const accountQuery = (id: string, accountId: string) =>
  queryOptions({
    queryKey: ['households', id, 'accounts', accountId],
    queryFn: async () => (await api<Data<Account>>('GET', `${hh(id)}/accounts/${accountId}`)).data,
  });

export const balancesQuery = (id: string, accountId: string) =>
  queryOptions({
    queryKey: ['households', id, 'accounts', accountId, 'balances'],
    queryFn: async () =>
      (await api<Data<BalancePoint[]>>('GET', `${hh(id)}/accounts/${accountId}/balances`)).data,
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
  accounts?: string[];
  categories?: string[];
  q?: string;
  review?: 'needs_review' | 'reviewed';
}

/** Pages of transactions, newest first, by cursor. */
export const transactionsQuery = (id: string, filters: TransactionFilters) =>
  infiniteQueryOptions({
    queryKey: ['households', id, 'transactions', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ lens: filters.lens, limit: '50' });
      if (filters.accounts?.length) params.set('accounts', filters.accounts.join(','));
      if (filters.categories?.length) params.set('categories', filters.categories.join(','));
      if (filters.q) params.set('q', filters.q);
      if (filters.review) params.set('review', filters.review);
      if (pageParam) params.set('cursor', pageParam);
      return api<{ data: Transaction[]; meta: { nextCursor: string | null } }>(
        'GET',
        `${hh(id)}/transactions?${params}`,
      );
    },
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });

export const transactionQuery = (id: string, transactionId: string) =>
  queryOptions({
    queryKey: ['households', id, 'transactions', 'one', transactionId],
    queryFn: async () =>
      (await api<Data<Transaction>>('GET', `${hh(id)}/transactions/${transactionId}`)).data,
  });
