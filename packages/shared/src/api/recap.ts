// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// The weekly recap (#128; bills walkthrough §8, D21): one person's week, from only what they can
// see (SYS-02). Built on the server, shown on the dashboard, and sent on Mondays by email for those
// who want it. A quiet week is still a recap, so it's clear nothing broke.

const isoDate = z.iso.date();
const minor = z.number().int();

/** Whose money it covers, in words: "yours and ours", or "yours". Null for someone on their own. */
export const recapSeesSchema = z.enum(['yours', 'yours_and_ours']).nullable();

export const recapComingUpSchema = z.object({
  due: isoDate,
  name: z.string(),
  kind: z.enum(['bill', 'subscription', 'income', 'transfer', 'statement']),
  /** Signed as its payments are: money out is negative. Null with nothing to go on. */
  amountMinor: minor.nullable(),
  /** An estimate ("about $64.20"), not a set amount; a card statement's balance is exact. */
  about: z.boolean(),
  /** Someone else who looks after it, where more than one of you sees it (D13, D22). */
  lookAfter: z.string().nullable(),
});
export type RecapComingUp = z.infer<typeof recapComingUpSchema>;

/** Things worth a look. New subscriptions and price rises come with #123 and #129. */
export const recapWorthALookSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('over_budget'), category: z.string(), overMinor: minor }),
  z.object({
    kind: z.literal('biggest_purchase'),
    name: z.string(),
    amountMinor: minor,
    /** Null when you see it only because it's for you, not its account (F1). */
    account: z.string().nullable(),
    date: isoDate,
  }),
  z.object({ kind: z.literal('late'), name: z.string(), due: isoDate }),
]);
export type RecapWorthALook = z.infer<typeof recapWorthALookSchema>;

export const weeklyRecapSchema = z.object({
  householdName: z.string(),
  /** The reader's name, for the greeting. */
  memberName: z.string(),
  currency: z.string(),
  /** The week it covers, first and last day, in the household's time zone and week start. */
  weekStart: isoDate,
  weekEnd: isoDate,
  /** The day it was built: "coming up" starts here. */
  today: isoDate,
  sees: recapSeesSchema,
  spending: z.object({
    spentMinor: minor,
    /** The average of the four weeks before; null without that much history. */
    usualMinor: minor.nullable(),
  }),
  /** This month's budgets you can see, added up; null without a budget. */
  budgets: z
    .object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      leftMinor: minor,
      /** Days left in the month, today included. */
      daysLeft: z.number().int(),
    })
    .nullable(),
  /** Null with no accounts that count toward net worth. */
  netWorth: z.object({ netWorthMinor: minor, changeMinor: minor }).nullable(),
  comingUp: z.array(recapComingUpSchema),
  worthALook: z.array(recapWorthALookSchema),
  /** Transactions waiting in your review queue. */
  toReview: z.number().int(),
  /** The household's activity history head (#389), so a kept recap can show it wasn't rewritten. */
  history: z.object({ seq: z.number().int(), hash: z.string() }),
  /** Nothing spent, nothing coming up, nothing worth a look: the short recap. */
  quiet: z.boolean(),
});
export type WeeklyRecap = z.infer<typeof weeklyRecapSchema>;

/** How much a notification says (ADR 0014 §5, D17): full, summary, or minimal. */
export type RecapDetail = 'full' | 'summary' | 'minimal';
