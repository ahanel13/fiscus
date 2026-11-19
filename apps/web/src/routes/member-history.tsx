// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HouseholdMember } from '@fiscus/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import {
  Alert,
  Button,
  DatePicker,
  DateText,
  Dialog,
  DialogActions,
  Form,
  Radio,
  RadioGroup,
  toast,
} from '../components/ui.js';

/**
 * A newer member's history window (#256, HH-14): the household's shared records (its budget's
 * months, household goals' history, activity) from the day they joined. Accounts shared with them
 * show their whole history anyway. Shown only for members who have a window.
 */
export function MemberHistory({
  householdId,
  member,
  isOwner,
}: {
  householdId: string;
  member: HouseholdMember;
  isOwner: boolean;
}) {
  const [open, setOpen] = useState(false);
  const from = member.historyFrom;
  if (from === null) return null;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-muted">
      <span>
        Sees shared history from <DateText value={from} />
      </span>
      {isOwner ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2.5 text-accent"
            onPress={() => setOpen(true)}
          >
            Show earlier
          </Button>
          <WidenHistoryDialog
            householdId={householdId}
            member={{ ...member, historyFrom: from }}
            isOpen={open}
            onOpenChange={setOpen}
          />
        </>
      ) : null}
    </span>
  );
}

/** HH-14: an owner widens a member's window, to an earlier date or to all of it. Never later. */
function WidenHistoryDialog({
  householdId,
  member,
  isOpen,
  onOpenChange,
}: {
  householdId: string;
  member: HouseholdMember & { historyFrom: string };
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [choice, setChoice] = useState<'all' | 'from'>('all');
  const [date, setDate] = useState<string | null>(null);
  const name = member.isYou ? 'you' : member.displayName;
  const widen = useMutation({
    mutationFn: (historyFrom: string | null) =>
      api('PUT', `/api/v1/households/${householdId}/members/${member.id}/history`, {
        body: { historyFrom },
      }),
    onSuccess: async () => {
      toast(
        member.isYou ? 'You now see more history.' : `${member.displayName} now sees more history.`,
      );
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: ['households', householdId] });
    },
  });
  const err = widen.error as ApiError | null;
  const before = (() => {
    const d = new Date(`${member.historyFrom}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  return (
    <Dialog
      title={member.isYou ? 'Show yourself earlier history' : `Show ${name} earlier history`}
      isOpen={isOpen}
      onOpenChange={(o) => {
        if (!o) widen.reset();
        onOpenChange(o);
      }}
    >
      <Form
        validationErrors={err?.fieldErrors()}
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          widen.mutate(choice === 'all' ? null : date);
        }}
      >
        {err?.formError ? <Alert>{err.formError}</Alert> : null}
        <p className="text-sm text-muted">
          {member.isYou ? 'You see' : `${member.displayName} sees`} the household’s shared budget,
          goals and activity from <DateText value={member.historyFrom} />, when{' '}
          {member.isYou ? 'you' : 'they'} joined. Accounts shared with{' '}
          {member.isYou ? 'you' : 'them'} already show their whole history. You can show more, but
          not take it back later.
        </p>
        <RadioGroup label="Show" value={choice} onChange={(v) => setChoice(v as 'all' | 'from')}>
          <Radio value="all">All of the household’s history</Radio>
          <Radio value="from">From a date</Radio>
        </RadioGroup>
        {choice === 'from' ? (
          <DatePicker label="From" value={date} onChange={setDate} maxValue={before} isRequired />
        ) : null}
        <DialogActions>
          <Button variant="secondary" onPress={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" isPending={widen.isPending} isDisabled={choice === 'from' && !date}>
            Show earlier history
          </Button>
        </DialogActions>
      </Form>
    </Dialog>
  );
}
