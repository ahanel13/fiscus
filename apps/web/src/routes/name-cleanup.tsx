// SPDX-License-Identifier: AGPL-3.0-or-later
import type { NameCleanup, NameCleanupPreview } from '@fiscus/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { Amount } from '../components/Amount.js';
import { Button, Card, DateText, Dialog, DialogActions, toast } from '../components/ui.js';
import { useInvalidateLedger } from './transactions.js';

type Data<T> = { data: T };

/**
 * Names still as the bank wrote them ("SQ *BLUE BOTTLE #1234"), and a way to clean them up
 * ("Blue Bottle"): a preview first, then all at once, with Undo (#42). The bank's text stays as
 * each transaction's original description. New imports are cleaned as they arrive.
 */
export function NameCleanupCard({ householdId }: { householdId: string }) {
  const base = `/api/v1/households/${householdId}/transactions/clean-names`;
  const invalidate = useInvalidateLedger(householdId);
  const preview = useQuery({
    queryKey: ['households', householdId, 'transactions', 'clean-names'],
    queryFn: async () => (await api<Data<NameCleanupPreview>>('GET', base)).data,
  });
  const [open, setOpen] = useState(false);
  const undo = useMutation({
    mutationFn: (changes: NameCleanup[]) =>
      api<Data<{ restored: number }>>('POST', `${base}/undo`, {
        body: { changes: changes.map(({ id, from, to }) => ({ id, from, to })) },
      }),
    onSuccess: async (r) => {
      await invalidate();
      toast(`${r.data.restored.toLocaleString('en-US')} names put back.`);
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });
  const clean = useMutation({
    mutationFn: () => api<Data<NameCleanup[]>>('POST', base),
    onSuccess: async (r) => {
      setOpen(false);
      await invalidate();
      const n = r.data.length;
      toast(`${n.toLocaleString('en-US')} ${n === 1 ? 'name' : 'names'} cleaned up.`, {
        description: 'The bank’s text is still each transaction’s original.',
        actions: [{ label: 'Undo', onAction: () => undo.mutate(r.data) }],
      });
    },
    onError: (e) => toast((e as ApiError).title, { tone: 'error' }),
  });

  const data = preview.data;
  if (!data || data.total === 0) return null;
  const n = data.total.toLocaleString('en-US');
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <Sparkles aria-hidden className="size-5 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">
          {n} {data.total === 1 ? 'name is' : 'names are'} still as the bank wrote{' '}
          {data.total === 1 ? 'it' : 'them'}
        </p>
        <p className="text-muted">
          Like “{data.changes[0]!.from}”, which would read “{data.changes[0]!.to}”. New imports are
          cleaned up as they arrive.
        </p>
      </div>
      <Button variant="secondary" size="sm" onPress={() => setOpen(true)}>
        Clean up names
      </Button>
      <Dialog title="Clean up names" size="lg" isOpen={open} onOpenChange={setOpen}>
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Processor prefixes, store numbers, and capitals go. Each transaction keeps the bank’s
            text as its original, and names you or a rule chose stay as they are.
          </p>
          <ul
            aria-label="Names that would change"
            className="max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border text-sm"
          >
            {data.changes.map((c) => (
              <li
                key={c.id}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 px-3 py-2"
              >
                <DateText value={c.date} className="text-xs text-muted" />
                <span className="min-w-0">
                  <span className="block truncate text-muted line-through">{c.from}</span>
                  <span className="block truncate font-medium">{c.to}</span>
                </span>
                <Amount minor={c.amountMinor} currency={c.currency} className="text-xs" />
              </li>
            ))}
          </ul>
          {data.total > data.changes.length ? (
            <p className="text-xs text-muted">
              Showing the newest {data.changes.length.toLocaleString('en-US')} of {n}.
            </p>
          ) : null}
          <DialogActions>
            <Button variant="secondary" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onPress={() => clean.mutate()} isPending={clean.isPending}>
              Clean up {n} {data.total === 1 ? 'name' : 'names'}
            </Button>
          </DialogActions>
        </div>
      </Dialog>
    </Card>
  );
}
