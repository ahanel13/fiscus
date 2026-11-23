// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AllocationStep,
  formatMoney,
  type GoalsOverview,
  suggestAllocation,
} from '@fiscus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { Alert, AmountInput, Button, Checkbox, Dialog, DialogActions, toast } from './ui.js';

// Unclaimed money toward goals, by priority (#136, goals walkthrough §5, G25). The suggestion is
// worked out here from what you see; nothing is earmarked until you confirm it.

/**
 * What priority suggests for the unclaimed money in your accounts: savings goals in priority
 * order, each up to what it still needs. Empty for viewers, who own no accounts.
 */
export function allocationOf(data: GoalsOverview): AllocationStep[] {
  if (!data.canCreate) return [];
  return suggestAllocation(
    data.goals
      .filter((g) => g.kind === 'save' && !g.done)
      .map((g) => ({
        goalId: g.id,
        needMinor: g.targetMinor - g.progressMinor,
        claims: g.claims
          .filter((c) => c.yours)
          .map((c) => ({ accountId: c.accountId, fixed: c.amountMinor !== null })),
      })),
    data.accounts,
  );
}

/** The goals a suggestion names, in order: "Cushion and Japan trip". */
export function goalNames(data: GoalsOverview, steps: AllocationStep[]): string {
  const names = [...new Set(steps.map((s) => s.goalId))].map(
    (id) => data.goals.find((g) => g.id === id)?.name ?? 'a goal',
  );
  return names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function AllocateDialog({
  householdId,
  data,
  steps,
  currency,
  onClose,
}: {
  householdId: string;
  data: GoalsOverview;
  steps: AllocationStep[];
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const money = (minor: number) => formatMoney(minor, currency);
  const [rows, setRows] = useState(
    steps.map((s) => ({ ...s, on: true, amount: s.amountMinor as number | null })),
  );
  const chosen = rows.filter((r) => r.on && (r.amount ?? 0) > 0);
  const total = chosen.reduce((s, r) => s + r.amount!, 0);
  const save = useMutation({
    mutationFn: () =>
      api('POST', `/api/v1/households/${householdId}/goals/allocate`, {
        body: {
          add: chosen.map((r) => ({
            goalId: r.goalId,
            accountId: r.accountId,
            amountMinor: r.amount!,
          })),
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['households', householdId, 'goals'] });
      toast(`${money(total)} earmarked. The money stays where it is.`);
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  return (
    <Dialog
      title="Put unclaimed money toward goals"
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <p className="text-sm text-muted">
          Priority suggests this: the top goal first, up to what it still needs, then the next.
          Nothing is earmarked until you say so, and no money moves.
        </p>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {rows.map((r, i) => {
            const g = data.goals.find((x) => x.id === r.goalId);
            const a = data.accounts.find((x) => x.accountId === r.accountId);
            // What the goal still needs after this step and the ones before it, as ticked.
            const left =
              (g?.targetMinor ?? 0) -
              (g?.progressMinor ?? 0) -
              rows
                .slice(0, i + 1)
                .filter((x) => x.goalId === r.goalId && x.on)
                .reduce((sum, x) => sum + (x.amount ?? 0), 0);
            const set = (patch: Partial<(typeof rows)[number]>) =>
              setRows((all) => all.map((x, k) => (k === i ? { ...x, ...patch } : x)));
            return (
              <li
                key={`${r.goalId}:${r.accountId}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
              >
                <Checkbox
                  isSelected={r.on}
                  onChange={(on) => set({ on })}
                  className="min-w-0 flex-1"
                >
                  <span className="min-w-0">
                    <span className="block font-medium">{g?.name}</span>
                    <span className="block text-xs text-muted">
                      From {a?.name}, which has {money(a?.unclaimedMinor ?? 0)} unclaimed.{' '}
                      {left <= 0 ? 'Reaches its target.' : `${money(left)} still to go after this.`}
                    </span>
                  </span>
                </Checkbox>
                <AmountInput
                  aria-label={`${g?.name}: amount from ${a?.name}`}
                  currency={currency}
                  value={r.amount}
                  onChange={(amount) => set({ amount })}
                  isDisabled={!r.on}
                  className="w-36"
                />
              </li>
            );
          })}
        </ul>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Not now
          </Button>
          <Button
            isPending={save.isPending}
            isDisabled={chosen.length === 0}
            onPress={() => save.mutate()}
          >
            Earmark {money(total)}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
