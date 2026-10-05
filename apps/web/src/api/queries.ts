// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  AuthStatus,
  Household,
  HouseholdMember,
  InvitePreview,
  Me,
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
