// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Account,
  AuthStatus,
  BalancePoint,
  Household,
  HouseholdMember,
  InvitePreview,
  Lens,
  Me,
  NetWorth,
  SessionSummary,
} from '@fiscus/shared';
import { queryOptions } from '@tanstack/react-query';
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
