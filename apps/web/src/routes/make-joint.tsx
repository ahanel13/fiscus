// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Users } from 'lucide-react';
import { api, type ApiError } from '../api/client.js';
import { accountsQuery, householdQuery, membersQuery } from '../api/queries.js';
import { Button, Checkbox, ConfirmDialog, DialogTrigger, toast } from '../components/ui.js';

/**
 * In a Combined household ("it's all ours", ADR 0006 §8): your accounts that aren't yet owned by
 * everyone with full visibility, and one click to make them so. Only your own (ACC-08); each member
 * sees this for theirs. Nothing shows once they're all joint.
 */
export function MakeJointOffer({ householdId }: { householdId: string }) {
  const household = useSuspenseQuery(householdQuery(householdId)).data;
  const members = useQuery(membersQuery(householdId)).data ?? [];
  const accounts = useQuery(accountsQuery(householdId, 'all')).data ?? [];
  const queryClient = useQueryClient();
  // "It's all ours" usually includes the past (#447); keeping it yours is a click away.
  const [keepPast, setKeepPast] = useState(false);
  const make = useMutation({
    mutationFn: () =>
      api<{ data: { changed: number } }>(
        'POST',
        `/api/v1/households/${householdId}/accounts/make-joint`,
        { body: { from: keepPast ? 'today' : 'always' } },
      ),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId] });
      toast(`${r.data.changed} ${r.data.changed === 1 ? 'account is' : 'accounts are'} joint now.`);
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });

  const everyone = members.filter((m) => m.role !== 'viewer');
  const notJoint = accounts.filter(
    (a) =>
      a.yourAccess === 'owner' &&
      (a.visibility !== 'full' ||
        a.owners.length !== everyone.length ||
        !everyone.every((m) => a.owners.some((o) => o.memberId === m.id))),
  );
  if (household.financeStyle !== 'combined' || everyone.length < 2 || notJoint.length === 0) {
    return null;
  }
  const n = notJoint.length;
  const others = everyone
    .filter((m) => !m.isYou)
    .map((m) => m.displayName)
    .join(' and ');
  return (
    <section
      aria-labelledby="make-joint"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3"
    >
      <Users aria-hidden className="size-5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1 text-sm">
        <h2 id="make-joint" className="font-semibold">
          Your household shares everything
        </h2>
        <p className="text-muted">
          {n === 1 ? 'One of your accounts isn’t' : `${n} of your accounts aren’t`} joint yet. Make{' '}
          {n === 1 ? 'it' : 'them'} owned by everyone, with {others} seeing everything in{' '}
          {n === 1 ? 'it' : 'them'}?
        </p>
      </div>
      <DialogTrigger>
        <Button variant="secondary" size="sm">
          Make {n === 1 ? 'it' : `all ${n}`} joint
        </Button>
        <ConfirmDialog
          title={`Make ${n === 1 ? 'this account' : `your ${n} accounts`} joint?`}
          confirmLabel="Make joint"
          onConfirm={() => make.mutateAsync()}
        >
          {notJoint.map((a) => a.name).join(', ')} will be owned by everyone in equal shares, and
          everyone can see and categorize {n === 1 ? 'its' : 'their'} transactions. Past spending
          counts as shared too, in budgets and shared costs. You can change an account’s owners
          later in its settings, though you can only remove yourself.
          <Checkbox className="mt-3" isSelected={keepPast} onChange={setKeepPast}>
            Keep spending from before today as mine
          </Checkbox>
        </ConfirmDialog>
      </DialogTrigger>
    </section>
  );
}
