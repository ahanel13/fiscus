// SPDX-License-Identifier: AGPL-3.0-or-later
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';
import { accountsQuery, connectionsQuery, membersQuery } from '../api/queries.js';
import { BankConnections } from '../components/BankConnections.js';
import { EmptyState } from '../components/EmptyState.js';
import { ButtonLink, Card, LoadingRegion, Skeleton } from '../components/ui.js';

/**
 * Household settings → Connections (bank connections walkthrough §7, #89): every connection behind
 * accounts you can see, who linked it, how many accounts, how it's doing, and what you may do.
 * Only its owner refreshes, signs in again, or disconnects it (ACC-03).
 */
export function ConnectionsSettings() {
  const { householdId } = useParams({ strict: false }) as { householdId: string };
  const connections = useQuery(connectionsQuery(householdId));
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const members = useQuery(membersQuery(householdId)).data ?? [];

  if (connections.isPending) {
    return (
      <LoadingRegion label="Loading connections">
        <Skeleton className="h-24" />
      </LoadingRegion>
    );
  }
  if (!connections.data?.length) {
    return (
      <EmptyState icon={Landmark} title="No banks connected">
        <p>Connect a bank from Accounts, and its accounts keep themselves up to date.</p>
        <ButtonLink variant="secondary" to="/h/$householdId/accounts" params={{ householdId }}>
          Go to Accounts
        </ButtonLink>
      </EmptyState>
    );
  }
  return (
    <>
      <p className="text-sm text-muted">
        Banks this household syncs with. Everyone sees the connections behind accounts they can see;
        only the person who linked one signs in again or disconnects it.
      </p>
      <BankConnections
        householdId={householdId}
        accounts={accounts}
        members={members}
        variant="settings"
      />
      <Card>
        <h2 className="font-semibold">Disconnecting</h2>
        <p className="mt-1 text-sm text-muted">
          Disconnecting stops syncing. The accounts and all their history stay, and become accounts
          you update by hand or with file imports. You can connect the bank again later and link
          them back.
        </p>
      </Card>
    </>
  );
}
