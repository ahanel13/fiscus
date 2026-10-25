// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  CategoryGroup,
  PossibleDuplicate,
  PossibleDuplicateDecision,
  TransferReviewTransaction,
} from '@fiscus/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { possibleDuplicatesQuery } from '../api/queries.js';
import { Amount } from '../components/Amount.js';
import { EmptyState } from '../components/EmptyState.js';
import {
  Alert,
  Badge,
  Button,
  DateText,
  LoadingRegion,
  Skeleton,
  toast,
} from '../components/ui.js';
import { categoryIndex } from '../lib/transactions.js';
import { useInvalidateLedger } from './transactions.js';

type Data<T> = { data: T };
type Decision = { decision: 'same'; transactionId: string } | { decision: 'different' };

const DAY_MS = 86_400_000;

/** Why it wasn't matched on its own: more than one like it, or another day. */
export function duplicateReason(d: PossibleDuplicate): string {
  if (d.candidates.length > 1) return `${d.candidates.length} like it here`;
  const only = d.candidates[0];
  if (!only) return 'nothing left to match';
  const days = Math.abs(Math.round((Date.parse(d.bank.date) - Date.parse(only.date)) / DAY_MS));
  return days === 0 ? 'same day' : `dates ${days} ${days === 1 ? 'day' : 'days'} apart`;
}

/**
 * Possible duplicates (#80, bank connections walkthrough D7): synced transactions that look like
 * ones already here. "Same transaction" keeps yours, with your category, notes, tags, splits and
 * attribution, and lets the bank update it from now on; "Different" adds the bank's. Only the
 * account's owners see these.
 */
export function PossibleDuplicatesList({
  householdId,
  groups,
}: {
  householdId: string;
  groups: CategoryGroup[];
}) {
  const query = useQuery(possibleDuplicatesQuery(householdId));
  const invalidate = useInvalidateLedger(householdId);
  const [announce, setAnnounce] = useState('');
  const { names } = categoryIndex(groups);
  const decide = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Decision }) =>
      api<Data<PossibleDuplicateDecision>>(
        'POST',
        `/api/v1/households/${householdId}/transactions/possible-duplicates/${id}`,
        { body },
      ),
    onSuccess: async (_, { body }) => {
      const message =
        body.decision === 'same'
          ? 'Kept yours. The bank updates it from now on.'
          : 'Added from the bank, to review.';
      toast(message);
      setAnnounce(message);
      await invalidate();
    },
    onError: async (e) => {
      const err = e as ApiError;
      toast(err.code === 'candidate_gone' ? 'That one can’t be matched any more' : err.title, {
        tone: 'error',
      });
      await invalidate();
    },
  });

  if (query.isPending) {
    return (
      <LoadingRegion label="Loading possible duplicates">
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      </LoadingRegion>
    );
  }
  if (query.isError)
    return <Alert>Couldn’t load possible duplicates. Try again in a moment.</Alert>;
  const list = query.data;
  if (list.length === 0) {
    return (
      <EmptyState icon={CheckCheck} title="No possible duplicates">
        <p>
          When a bank sends a transaction that looks like one you already have, it waits here
          instead of counting twice.
        </p>
      </EmptyState>
    );
  }

  const pending = (id: string, kind: Decision['decision'], transactionId?: string) =>
    decide.isPending &&
    decide.variables?.id === id &&
    decide.variables.body.decision === kind &&
    (kind === 'different' ||
      (decide.variables.body.decision === 'same' &&
        decide.variables.body.transactionId === transactionId));
  const describe = (t: TransferReviewTransaction) =>
    t.categoryId ? (names.get(t.categoryId) ?? 'Uncategorized') : 'Uncategorized';

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Each has the same amount as one of yours within a few days. Same transaction keeps yours,
        with your category, notes and tags, and lets the bank update it from now on.
      </p>
      <ul className="space-y-4">
        {list.map((d) => (
          <li
            key={d.id}
            aria-label={`${d.bank.displayName}, from the bank`}
            className="space-y-3 rounded-xl border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Amount
                minor={d.bank.amountMinor}
                currency={d.bank.currency}
                className="font-medium"
              />
              <span className="text-sm text-muted">{d.account.name}</span>
              <Badge className="ml-auto">{duplicateReason(d)}</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                {d.candidates.length === 0 ? (
                  <p className="rounded-lg bg-surface-2 p-3 text-sm text-muted">
                    The transactions it looked like were deleted or matched to another of the bank’s
                    since. It can only be added.
                  </p>
                ) : (
                  d.candidates.map((c) => (
                    <div
                      key={c.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 p-3"
                    >
                      <div className="min-w-0 flex-1 text-sm">
                        <p className="text-xs text-muted">Yours</p>
                        <p className="truncate font-medium">
                          <DateText value={c.date} /> · {c.displayName}
                        </p>
                        <p className="truncate text-xs text-muted">{describe(c)}</p>
                      </div>
                      {d.candidates.length > 1 ? (
                        <Button
                          variant="secondary"
                          onPress={() =>
                            decide.mutate({
                              id: d.id,
                              body: { decision: 'same', transactionId: c.id },
                            })
                          }
                          isPending={pending(d.id, 'same', c.id)}
                        >
                          This one
                          {/* The visible words first, then which one (WCAG 2.5.3). */}
                          <span className="sr-only">
                            : {c.displayName}, <DateText value={c.date} />
                          </span>
                        </Button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
              <div className="rounded-lg bg-surface-2 p-3 text-sm">
                <p className="text-xs text-muted">From the bank</p>
                <p className="truncate font-medium">
                  <DateText value={d.bank.date} /> · {d.bank.displayName}
                </p>
                {d.bank.originalDescription !== d.bank.displayName ? (
                  <p className="truncate text-xs text-muted">{d.bank.originalDescription}</p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="secondary"
                onPress={() => decide.mutate({ id: d.id, body: { decision: 'different' } })}
                isPending={pending(d.id, 'different')}
              >
                {d.candidates.length ? 'Different transactions' : 'Add it'}
              </Button>
              {d.candidates.length === 1 ? (
                <Button
                  onPress={() =>
                    decide.mutate({
                      id: d.id,
                      body: { decision: 'same', transactionId: d.candidates[0]!.id },
                    })
                  }
                  isPending={pending(d.id, 'same', d.candidates[0]!.id)}
                >
                  Same transaction
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p role="status" className="sr-only">
        {announce}
      </p>
    </div>
  );
}
