// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  estimatedMinimum,
  formatMoney,
  type Goal,
  type GoalClaim,
  type HouseholdMember,
} from '@fiscus/shared';
import { clsx } from 'clsx';
import { Check, MoreHorizontal } from 'lucide-react';
import { BankLogo } from './BankLogo.js';
import { GoalPicture, type GoalLook, goalPhotoUrl } from './GoalPicture.js';
import { Badge, type BadgeTone, Button, Menu, MenuItem, MenuTrigger } from './ui.js';

// A goal as a row (goals walkthrough §1, §8), saving up or paying down: its picture, name and
// banks, status with when its pace gets there, what it has, and its bar.

/** "Mar 2054", from `YYYY-MM` or a date. */
export const shortMonth = (month: string) =>
  new Date(`${month.slice(0, 7)}-01T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });

/** A goal's picture: its photo, else its icon and color. */
export const lookOf = (householdId: string, g: Goal): GoalLook => ({
  icon: g.icon,
  color: g.color,
  photo: g.imageVersion ? goalPhotoUrl(householdId, g.id, g.imageVersion) : null,
});

const STATUS: Record<
  NonNullable<Goal['pace']['status']>,
  { label: string; tone: BadgeTone; bar: string }
> = {
  done: { label: 'Completed', tone: 'positive', bar: 'bg-positive' },
  on_track: { label: 'On track', tone: 'accent', bar: 'bg-accent' },
  at_risk: { label: 'At risk', tone: 'warning', bar: 'bg-warning' },
  short: { label: 'Short', tone: 'danger', bar: 'bg-danger' },
};

/** A claim's account, as you may see it: its name, or only whose it is (G7). */
export function claimLabel(c: GoalClaim, members: HouseholdMember[]): string {
  if (c.accountName) return c.accountName;
  const owners = c.ownerIds.map((id) => members.find((m) => m.id === id)?.displayName ?? 'Someone');
  return `${owners.join(' and ')}’s account`;
}

/** "24.99%", from basis points. */
export const percentOf = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** When a goal's pace gets there, against its own date: the line beside its status. */
function whenOf(g: Goal, money: (minor: number) => string): string {
  const { status, projectedMonth, monthsLate } = g.pace;
  if (g.archivedAt) return `Archived ${shortMonth(g.archivedAt)}`;
  if (g.debt?.owedMinor === null) return 'Only its owners see this debt now';
  const debt = g.debt !== null;
  if (status === 'done') {
    if (debt) return 'Nothing owed';
    return g.targetDate ? `Target ${shortMonth(g.targetDate)}` : 'No target date';
  }
  if (status === 'short') return `${money(g.shortMinor)} short in its accounts`;
  if (status === 'at_risk') {
    if (!projectedMonth) {
      return debt ? 'Its payments don’t pay it off' : 'No monthly plan to get there';
    }
    return `${shortMonth(projectedMonth)} (${monthsLate} ${monthsLate === 1 ? 'month' : 'months'} behind)`;
  }
  if (status === 'on_track') {
    return `${shortMonth(projectedMonth!)} · target ${shortMonth(g.targetDate!)}`;
  }
  if (!projectedMonth) return debt ? 'Its payments don’t pay it off' : 'No target date';
  return debt
    ? `Paid off by ${shortMonth(projectedMonth)}`
    : `No target date · about ${shortMonth(projectedMonth)} at its plan`;
}

export function GoalRow({
  householdId,
  goal: g,
  currency,
  members,
  shared,
  onOpen,
  onArchive,
  onRestore,
  onDelete,
  onUp,
  onDown,
}: {
  householdId: string;
  goal: Goal;
  currency: string;
  members: HouseholdMember[];
  shared: boolean;
  onOpen?: (() => void) | undefined;
  onArchive?: (() => void) | undefined;
  onRestore?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onUp?: (() => void) | undefined;
  onDown?: (() => void) | undefined;
}) {
  const share = Math.min(1, g.progressMinor / g.targetMinor);
  const percent = Math.floor((g.progressMinor / g.targetMinor) * 100);
  const money = (minor: number) => formatMoney(minor, currency);
  const { status } = g.pace;
  const badge = status ? STATUS[status] : null;
  const debt = g.debt;
  // A debt shows what's owed; saving up, what it has. Archived, what it had.
  const headline =
    debt && !g.archivedAt
      ? debt.owedMinor === null
        ? '—'
        : `${money(debt.owedMinor)} owed`
      : money(g.progressMinor);
  const sub = debt
    ? `${percent}% paid of ${money(g.targetMinor)}`
    : `${percent}% of ${money(g.targetMinor)}`;
  const banks = debt
    ? [{ key: debt.accountId, institution: debt.institution, name: debt.accountName ?? g.name }]
    : g.claims.slice(0, 3).map((c) => ({
        key: c.accountId,
        institution: c.institution,
        name: claimLabel(c, members),
      }));
  const menu = onOpen || onArchive || onRestore || onDelete || onUp || onDown;
  return (
    <article
      aria-label={g.name}
      className="relative flex gap-3 px-4 py-4 hover:bg-surface-2/50 sm:gap-4 sm:px-5"
    >
      <GoalPicture look={lookOf(householdId, g)} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-base font-medium">
              {onOpen ? (
                // The whole row opens it; the name is the button that says so.
                <button
                  type="button"
                  onClick={onOpen}
                  className="truncate text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-accent"
                >
                  {g.name}
                </button>
              ) : (
                <span className="truncate">{g.name}</span>
              )}
              {banks.length ? (
                <span className="flex items-center -space-x-1.5">
                  {banks.map((b) => (
                    <BankLogo key={b.key} institution={b.institution} name={b.name} size="sm" />
                  ))}
                  {!debt && g.claims.length > 3 ? (
                    <span className="pl-2.5 text-xs text-muted">+{g.claims.length - 3}</span>
                  ) : null}
                </span>
              ) : null}
              {shared ? (
                <span className="text-xs font-normal text-muted">
                  {g.scope === 'mine' ? 'Mine' : 'Ours'}
                </span>
              ) : null}
            </h3>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
              {badge ? (
                <Badge tone={badge.tone}>
                  {status === 'done' ? <Check aria-hidden className="size-3" /> : null}
                  {status === 'done' && debt ? 'Paid off' : badge.label}
                </Badge>
              ) : null}
              <span>{whenOf(g, money)}</span>
            </p>
            {/* On a phone, the amounts get their own line, so the name has the width. */}
            <p className="text-sm text-muted sm:hidden">
              <span className="font-semibold text-fg tabular-nums">{headline}</span> · {sub}
            </p>
          </div>
          <div className="flex shrink-0 items-start gap-1">
            <div className="hidden text-right sm:block">
              <p className="text-base font-semibold tabular-nums">{headline}</p>
              <p className="text-sm text-muted tabular-nums">{sub}</p>
            </div>
            {menu ? (
              <MenuTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${g.name}: more`}
                  className="relative z-10"
                >
                  <MoreHorizontal aria-hidden className="size-4" />
                </Button>
                <Menu placement="bottom end">
                  {onOpen ? <MenuItem onAction={onOpen}>Edit</MenuItem> : null}
                  {onUp ? <MenuItem onAction={onUp}>Move up in priority</MenuItem> : null}
                  {onDown ? <MenuItem onAction={onDown}>Move down in priority</MenuItem> : null}
                  {onArchive ? <MenuItem onAction={onArchive}>Archive</MenuItem> : null}
                  {onRestore ? <MenuItem onAction={onRestore}>Bring back</MenuItem> : null}
                  {onDelete ? <MenuItem onAction={onDelete}>Delete</MenuItem> : null}
                </Menu>
              </MenuTrigger>
            ) : null}
          </div>
        </div>
        <div
          className="h-2 rounded-full bg-surface-2"
          role="meter"
          aria-label={`${g.name}: ${percent}% of its target`}
          aria-valuenow={Math.min(100, percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={clsx('h-full rounded-full', badge ? badge.bar : 'bg-accent')}
            style={{ width: `${share * 100}%` }}
          />
        </div>
        {debt && !g.archivedAt && debt.owedMinor !== null ? (
          <DebtTerms goal={g} money={money} onSetUp={onOpen} />
        ) : !g.archivedAt && !debt && g.claims.length === 0 ? (
          <p className="text-xs text-muted">Not funded yet: no account drawn on.</p>
        ) : null}
      </div>
    </article>
  );
}

/** A debt's rate and payments: "24.99% APR · $100 minimum + $200 extra", or what to set up. */
function DebtTerms({
  goal: g,
  money,
  onSetUp,
}: {
  goal: Goal;
  money: (minor: number) => string;
  onSetUp?: (() => void) | undefined;
}) {
  const d = g.debt!;
  const minimum = d.minimumMinor ?? estimatedMinimum(d.owedMinor ?? 0);
  return (
    <p className="relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {d.aprBps !== null ? (
        <span>{percentOf(d.aprBps)} APR</span>
      ) : onSetUp ? (
        <button
          type="button"
          onClick={onSetUp}
          className="font-medium text-accent-text underline underline-offset-2"
        >
          Set up APR
        </button>
      ) : (
        <span>No APR yet</span>
      )}
      <span aria-hidden>·</span>
      <span>
        {money(minimum)} minimum{d.minimumMinor === null ? ' (estimated)' : ''}
        {g.planMinor ? ` + ${money(g.planMinor)} extra` : ''} a month
      </span>
    </p>
  );
}
