// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  FUNDING_CADENCE_LABELS,
  FUNDING_CADENCES,
  type FundingAccount,
  type FundingCadence,
  type FundingTarget,
  type FundingTargets,
  type HouseholdMember,
} from '@fiscus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { api, type ApiError } from '../api/client.js';
import { Amount } from '../components/Amount.js';
import {
  Alert,
  AmountInput,
  Avatar,
  Badge,
  type BadgeTone,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DialogActions,
  SegmentedControl,
  Skeleton,
  toast,
} from '../components/ui.js';

// Joint-account funding targets (#113, ADR 0006 §7.3): what each of you moves into a joint
// account a week, two weeks or month, against the transfers in from your own accounts.

const base = (householdId: string) => `/api/v1/households/${householdId}/funding-targets`;

export const fundingTargetsQuery = (householdId: string) => ({
  queryKey: ['households', householdId, 'funding-targets'],
  queryFn: async () => (await api<{ data: FundingTargets }>('GET', base(householdId))).data,
});

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

const PERIOD_NAMES: Record<FundingCadence, string> = {
  weekly: 'This week',
  every_two_weeks: 'These two weeks',
  monthly: 'This month',
};

const CADENCE_OPTIONS = FUNDING_CADENCES.map((value) => ({
  value,
  label: { weekly: 'Weekly', every_two_weeks: 'Every two weeks', monthly: 'Monthly' }[value],
}));

/** The status as a badge: "On track", "Behind $300.00", "Ahead $20.00", "Starts Mar 1". */
export function statusBadge(
  t: FundingTarget,
  currency: string,
): { tone: BadgeTone; label: ReactNode } {
  const by = <Amount minor={t.differenceMinor} currency={currency} kind="balance" />;
  switch (t.status) {
    case 'behind':
      return { tone: 'warning', label: <>Behind {by}</> };
    case 'ahead':
      return { tone: 'positive', label: <>Ahead {by}</> };
    case 'not_started':
      return { tone: 'neutral', label: `Starts ${shortDate(t.startsOn)}` };
    default:
      return { tone: 'positive', label: 'On track' };
  }
}

/** The Shared costs page's funding section: joint accounts you own, or see with targets. */
export function FundingSection({
  householdId,
  members,
  canEdit,
}: {
  householdId: string;
  members: HouseholdMember[];
  /** Viewers read only. */
  canEdit: boolean;
}) {
  const data = useQuery(fundingTargetsQuery(householdId));
  const [editing, setEditing] = useState<{
    account: FundingAccount;
    member: HouseholdMember;
    target: FundingTarget | null;
  } | null>(null);
  const [removing, setRemoving] = useState<{
    account: FundingAccount;
    member: HouseholdMember;
  } | null>(null);
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (r: { account: FundingAccount; member: HouseholdMember }) =>
      api('DELETE', `${base(householdId)}/${r.account.accountId}/${r.member.id}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'funding-targets'],
      });
      toast('Target removed.');
    },
  });

  if (data.isPending) return <Skeleton className="h-40" />;
  if (data.isError) return <Alert>Couldn’t load funding targets. Try again in a moment.</Alert>;
  const accounts = data.data.accounts;
  if (accounts.length === 0) return null;
  const you = members.find((m) => m.isYou);

  return (
    <section aria-labelledby="funding" className="space-y-3">
      <div>
        <h2 id="funding" className="text-base font-semibold">
          Funding joint accounts
        </h2>
        <p className="text-sm text-muted">
          What each of you has agreed to move in, against the transfers from your own accounts.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {accounts.map((a) => {
          const owns = canEdit && !!you && a.ownerIds.includes(you.id);
          return (
            <Card key={a.accountId} className="space-y-3">
              <h3 className="font-semibold">{a.accountName}</h3>
              <ul className="divide-y divide-border">
                {a.ownerIds.map((id) => {
                  const m = members.find((x) => x.id === id);
                  if (!m) return null;
                  const t = a.targets.find((x) => x.memberId === id) ?? null;
                  return (
                    <OwnerRow
                      key={id}
                      member={m}
                      target={t}
                      currency={a.currency}
                      onEdit={
                        owns ? () => setEditing({ account: a, member: m, target: t }) : undefined
                      }
                      onRemove={
                        owns && t ? () => setRemoving({ account: a, member: m }) : undefined
                      }
                    />
                  );
                })}
              </ul>
            </Card>
          );
        })}
      </div>
      {editing ? (
        <TargetDialog
          householdId={householdId}
          {...editing}
          currency={editing.account.currency}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {removing ? (
        <ConfirmDialog
          isOpen
          onOpenChange={(open) => (open ? null : setRemoving(null))}
          title={`Remove ${removing.member.isYou ? 'your' : `${removing.member.displayName}’s`} target?`}
          confirmLabel="Remove"
          destructive
          onConfirm={() => remove.mutateAsync(removing).then(() => setRemoving(null))}
        >
          {removing.account.accountName} stops tracking what{' '}
          {removing.member.isYou ? 'you move' : `${removing.member.displayName} moves`} in. The
          transfers stay as they are.
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function OwnerRow({
  member,
  target,
  currency,
  onEdit,
  onRemove,
}: {
  member: HouseholdMember;
  target: FundingTarget | null;
  currency: string;
  onEdit: (() => void) | undefined;
  onRemove: (() => void) | undefined;
}) {
  const name = member.isYou ? 'You' : member.displayName;
  const money = (minor: number) => <Amount minor={minor} currency={currency} kind="balance" />;
  const badge = target ? statusBadge(target, currency) : null;
  return (
    <li className="space-y-1 py-3 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <Avatar name={member.displayName} color={member.color} size="sm" />
        <span className="font-medium">{name}</span>
        {target ? (
          <span className="text-muted">
            {money(target.amountMinor)} {FUNDING_CADENCE_LABELS[target.cadence]}
          </span>
        ) : (
          <span className="text-muted">No target</span>
        )}
        {badge ? (
          <Badge tone={badge.tone} className="ml-auto">
            {badge.label}
          </Badge>
        ) : null}
      </div>
      {target?.current ? (
        <p className="text-xs text-muted">
          {PERIOD_NAMES[target.cadence]}: {money(target.current.contributedMinor)} in
          {target.leftThisPeriodMinor > 0 ? (
            <> · {money(target.leftThisPeriodMinor)} to go</>
          ) : null}
          {' · '}
          {money(target.contributedMinor)} since {shortDate(target.startsOn)}
        </p>
      ) : null}
      {onEdit || onRemove ? (
        <div className="flex gap-2">
          {onEdit ? (
            <Button variant="ghost" size="sm" onPress={onEdit}>
              {target ? 'Change' : 'Set a target'}
            </Button>
          ) : null}
          {onRemove ? (
            <Button variant="ghost" size="sm" onPress={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function TargetDialog({
  householdId,
  account,
  member,
  target,
  currency,
  onClose,
}: {
  householdId: string;
  account: FundingAccount;
  member: HouseholdMember;
  target: FundingTarget | null;
  currency: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState<number | null>(target?.amountMinor ?? null);
  const [cadence, setCadence] = useState<FundingCadence>(target?.cadence ?? 'monthly');
  const save = useMutation({
    mutationFn: () =>
      api('PUT', `${base(householdId)}/${account.accountId}/${member.id}`, {
        body: { method: 'fixed', amountMinor: amount ?? 0, cadence },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['households', householdId, 'funding-targets'],
      });
      toast('Target saved.');
      onClose();
    },
  });
  const err = save.error as ApiError | null;
  const whose = member.isYou ? 'Your' : `${member.displayName}’s`;
  return (
    <Dialog
      title={`${whose} target for ${account.accountName}`}
      isOpen
      onOpenChange={(open) => (open ? null : onClose())}
    >
      <div className="space-y-4">
        {err ? <Alert>{err.detail ?? err.title}</Alert> : null}
        <AmountInput
          label={member.isYou ? 'You move in' : `${member.displayName} moves in`}
          currency={currency}
          value={amount}
          onChange={setAmount}
        />
        <div className="space-y-1">
          <span className="block text-sm font-medium">How often</span>
          <SegmentedControl
            aria-label="How often"
            options={CADENCE_OPTIONS}
            value={cadence}
            onChange={setCadence}
          />
        </div>
        <p className="text-xs text-muted">
          Transfers into {account.accountName} from{' '}
          {member.isYou ? 'your' : `${member.displayName}’s`} own accounts count toward it. Monthly
          targets follow calendar months.
          {target ? ' Changing it starts counting again from this period.' : ''} Everyone who sees
          the account’s transactions sees the target.
        </p>
        <DialogActions>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
          <Button isDisabled={!amount} isPending={save.isPending} onPress={() => save.mutate()}>
            Save
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  );
}
