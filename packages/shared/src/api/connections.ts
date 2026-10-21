// SPDX-License-Identifier: AGPL-3.0-or-later

// Bank connections (#78, the bank connections walkthrough §7). A connection is listed for its
// owner and for anyone who sees one of its accounts (ACC-02); its secret never leaves the server.

export type ConnectionProvider = 'plaid' | 'simplefin';
/** `setup`: owners and visibility not confirmed yet, so only its owner sees it (D4). */
export type ConnectionStatus = 'setup' | 'ok' | 'login_required' | 'error' | 'disconnected';

export interface Connection {
  id: string;
  provider: ConnectionProvider;
  status: ConnectionStatus;
  institutionName: string | null;
  /** Who linked it: the one who fixes or disconnects it (ACC-03, D11). */
  owner: { memberId: string; name: string };
  /** The accounts it syncs that you can see. */
  accountCount: number;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
}
