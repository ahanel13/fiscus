// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { addDays } from '@fiscus/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../../testing/harness.js';
import { localTime, NotificationRules } from './runner.js';

/**
 * The notification rules (#127; bills walkthrough D18–D20) against Postgres, as fiscus_worker:
 * who gets what, on what day, once, and never about what they can't see (D15) [SYS-02].
 */

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const NOW = new Date();
const TODAY = localTime('UTC', NOW).date;
const AT = (hour: number) => ({ ...localTime('UTC', NOW), hour });

describe('notification rules', { timeout: 120_000 }, () => {
  let h: WorkerHarness;
  const rules = () => new NotificationRules(h.worker.db, {}, quiet);

  beforeAll(async () => {
    h = await startWorkerHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  /** A household of Alex (owner) and Sam, a member, in UTC. */
  const household = async () => {
    const { householdId, memberId: alex } = await h.household();
    const sam = await h.member(householdId, 'Sam');
    return { householdId, alex, sam };
  };
  const sent = async (memberId: string, kind?: string) =>
    (
      await h.owner.query(
        `SELECT kind, title, body, summary, link, dedupe_key FROM notifications
         WHERE member_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY created_at, title`,
        [memberId, kind ?? null],
      )
    ).rows;
  const txn = (
    householdId: string,
    accountId: string,
    amountMinor: number,
    date: string,
    name = 'Costco',
    extra: Record<string, unknown> = {},
  ) =>
    h.owner.query(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
         authorized_date, original_description, display_name, source, review_status)
       VALUES ($1, $2, $3, $4, 'USD', $5, $6, $6, 'manual', $7)`,
      [
        randomUUID(),
        householdId,
        accountId,
        amountMinor,
        date,
        name,
        extra.reviewStatus ?? 'reviewed',
      ],
    );
  const series = async (
    householdId: string,
    accountId: string,
    by: string,
    fields: {
      name: string;
      kind: string;
      day: number;
      direction?: 'in' | 'out';
      responsible?: string;
    },
  ) => {
    const id = randomUUID();
    await h.owner.query(
      `INSERT INTO recurring_series (id, household_id, account_id, name, kind, match, schedule,
         window_days, created_by_member_id, responsible_member_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 3, $8, $9, now() - interval '400 days')`,
      [
        id,
        householdId,
        accountId,
        fields.name,
        fields.kind,
        JSON.stringify({
          direction: fields.direction ?? 'out',
          description: { op: 'contains', value: fields.name },
        }),
        JSON.stringify({
          unit: 'day',
          every: 30,
          anchor: addDays(TODAY, fields.day),
          weekend: 'as_is',
        }),
        by,
        fields.responsible ?? null,
      ],
    );
    return id;
  };
  const prefer = (memberId: string, householdId: string, kind: string, settings: object) =>
    h.owner.query(
      `INSERT INTO notification_preferences (household_id, member_id, kind, settings)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (member_id, kind) DO UPDATE SET settings = EXCLUDED.settings`,
      [householdId, memberId, kind, JSON.stringify(settings)],
    );

  it('reminds whoever looks after a bill, days before, once, and not once it’s paid (D13, D20)', async () => {
    const { householdId, alex, sam } = await household();
    const joint = await h.account({ householdId, owners: [alex, sam], name: 'Joint checking' });
    const power = await series(householdId, joint, alex, {
      name: 'Lakeside Power',
      kind: 'bill',
      day: 2,
      responsible: sam,
    });
    await series(householdId, joint, alex, {
      name: 'Streamly',
      kind: 'subscription',
      day: 1,
      responsible: sam,
    });
    const paid = await series(householdId, joint, alex, {
      name: 'County Water',
      kind: 'bill',
      day: 2,
      responsible: sam,
    });
    // Paid early: no reminder (D20).
    await txn(householdId, joint, -4_500, TODAY, 'County Water');
    const r = rules();
    await r.runHousehold(householdId, AT(9), { daily: true });
    await r.runHousehold(householdId, AT(10), { daily: true });
    const due = await sent(sam, 'bill_due');
    expect(due.map((n) => n.dedupe_key).sort()).toEqual(
      [
        `bill_due:${power}:${addDays(TODAY, 2)}`,
        `bill_due:${(await h.owner.query(`SELECT id FROM recurring_series WHERE name = 'Streamly' AND household_id = $1`, [householdId])).rows[0].id}:${addDays(TODAY, 1)}`,
      ].sort(),
    );
    expect(due.find((n) => n.title.startsWith('Streamly'))).toMatchObject({
      title: 'Streamly is due tomorrow',
      body: 'From Joint checking.',
      summary: 'A bill is due soon.',
      link: `/h/${householdId}/recurring`,
    });
    expect(due.some((n) => n.dedupe_key.includes(paid))).toBe(false);
    // Alex doesn't look after them: nothing for Alex.
    expect(await sent(alex, 'bill_due')).toEqual([]);
  });

  it('waits for the days before they chose', async () => {
    const { householdId, alex } = await household();
    const mine = await h.account({ householdId, owners: [alex], name: 'Checking' });
    await series(householdId, mine, alex, { name: 'Rent', kind: 'bill', day: 5 });
    await rules().runHousehold(householdId, AT(9), { daily: true });
    expect(await sent(alex, 'bill_due')).toEqual([]);
    await prefer(alex, householdId, 'bill_due', { daysBefore: 7 });
    await rules().runHousehold(householdId, AT(9), { daily: true });
    expect((await sent(alex, 'bill_due')).map((n) => n.title)).toEqual([
      expect.stringMatching(/^Rent is due on /),
    ]);
  });

  it('says a bill or paycheck is late, the paycheck to whoever it’s for', async () => {
    const { householdId, alex, sam } = await household();
    const samsChecking = await h.account({ householdId, owners: [sam], name: 'Sam checking' });
    await series(householdId, samsChecking, sam, {
      name: 'Brightline Labs',
      kind: 'income',
      direction: 'in',
      day: -3,
    });
    await series(householdId, samsChecking, sam, { name: 'Gym', kind: 'bill', day: -4 });
    await rules().runHousehold(householdId, AT(9), { daily: true });
    expect((await sent(sam, 'late')).map((n) => n.title).sort()).toEqual([
      'Brightline Labs hasn’t come in',
      'Gym hasn’t been paid',
    ]);
    expect(await sent(alex, 'late')).toEqual([]);
  });

  it('never tells anyone about a big purchase on a card they can’t see [SYS-02]', async () => {
    const { householdId, alex, sam } = await household();
    const samsCard = await h.account({
      householdId,
      owners: [sam],
      name: 'Sam’s card',
      type: 'credit',
      visibility: 'private',
    });
    const joint = await h.account({
      householdId,
      owners: [alex, sam],
      name: 'Joint card',
      type: 'credit',
    });
    const since = new Date(Date.now() - 60_000);
    await txn(householdId, samsCard, -61_200, TODAY, 'Jeweler');
    await txn(householdId, joint, -41_218, TODAY, 'Costco');
    await prefer(alex, householdId, 'big_transaction', { overMinor: 40_000 });
    await prefer(sam, householdId, 'big_transaction', { overMinor: 40_000 });
    const r = rules();
    await r.runBigTransactions(householdId, AT(12), since);
    await r.runBigTransactions(householdId, AT(13), since);
    expect((await sent(sam, 'big_transaction')).map((n) => n.title).sort()).toEqual([
      '$412.18 at Costco',
      '$612 at Jeweler',
    ]);
    const alexs = await sent(alex);
    expect(alexs.map((n) => n.title)).toEqual(['$412.18 at Costco']);
    // Nothing of Sam's card reaches Alex, in any notification.
    expect(JSON.stringify(alexs)).not.toMatch(/Jeweler|Sam’s card|612/);
  });

  it('leaves out small, pending, transfer and old transactions', async () => {
    const { householdId, alex } = await household();
    const card = await h.account({ householdId, owners: [alex], name: 'Card', type: 'credit' });
    const since = new Date(Date.now() - 60_000);
    await txn(householdId, card, -49_999, TODAY, 'Small');
    await txn(householdId, card, -90_000, addDays(TODAY, -30), 'Old');
    await txn(householdId, card, 90_000, TODAY, 'Refund');
    await h.owner.query(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
         authorized_date, original_description, display_name, source, pending)
       VALUES (gen_random_uuid(), $1, $2, -90000, 'USD', $3, 'Pending', 'Pending', 'manual', true)`,
      [householdId, card, TODAY],
    );
    await rules().runBigTransactions(householdId, AT(12), since);
    expect(await sent(alex)).toEqual([]);
  });

  it('warns of a low balance now, or in the next 2 weeks with confirmed bills (D19)', async () => {
    const { householdId, alex } = await household();
    const low = await h.account({ householdId, owners: [alex], name: 'Everyday checking' });
    const soon = await h.account({ householdId, owners: [alex], name: 'Bills checking' });
    for (const [id, minor] of [
      [low, 80_000],
      [soon, 150_000],
    ] as const) {
      await h.owner.query(
        `INSERT INTO balance_snapshots (account_id, as_of, household_id, balance_minor, source)
         VALUES ($1, $2, $3, $4, 'manual')`,
        [id, addDays(TODAY, -1), householdId, minor],
      );
    }
    // Rent of about $900, paid from Bills checking every 30 days, due in 5.
    await series(householdId, soon, alex, { name: 'Rent', kind: 'bill', day: 5 - 30 });
    await txn(householdId, soon, -90_000, addDays(TODAY, -25), 'Rent');
    await rules().runHousehold(householdId, AT(9), { daily: true });
    expect(await sent(alex, 'low_balance')).toEqual([]); // off until you pick an account
    await prefer(alex, householdId, 'low_balance', {
      accountIds: [low, soon],
      underMinor: 100_000,
    });
    await rules().runHousehold(householdId, AT(9), { daily: true });
    const titles = (await sent(alex, 'low_balance')).map((n) => n.title).sort();
    expect(titles).toEqual([
      'Bills checking could go under $1,000',
      'Everyday checking is under $1,000',
    ]);
  });

  it('says a budget category is nearly spent, once a month, from the member’s own view', async () => {
    const { householdId, alex, sam } = await household();
    const joint = await h.account({ householdId, owners: [alex, sam], name: 'Joint' });
    const [groceries] = (
      await h.owner.query(
        `SELECT id FROM categories WHERE household_id = $1 AND name = 'Groceries'`,
        [householdId],
      )
    ).rows;
    const budget = randomUUID();
    const month = `${TODAY.slice(0, 7)}-01`;
    await h.owner.query(
      `INSERT INTO budgets (id, household_id, starts_month) VALUES ($1, $2, $3);
       INSERT INTO budget_strategies (household_id, budget_id, from_month, strategy)
         VALUES ($2, $1, $3, 'category');
       INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
         VALUES ($2, $1, $3, $4, 50000)`.replace(
        /\$(\d)/g,
        (_, n) =>
          ['', `'${budget}'`, `'${householdId}'`, `'${month}'`, `'${groceries.id}'`][Number(n)]!,
      ),
    );
    await h.owner.query(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
         authorized_date, original_description, display_name, source, category_id)
       VALUES (gen_random_uuid(), $1, $2, -46000, 'USD', $3, 'Market', 'Market', 'manual', $4)`,
      [householdId, joint, month, groceries.id],
    );
    const r = rules();
    await r.runHousehold(householdId, AT(9), { daily: true });
    await r.runHousehold(householdId, AT(9), { daily: true });
    for (const m of [alex, sam]) {
      expect(await sent(m, 'budget_nearly_spent')).toMatchObject([
        {
          title: 'Groceries is at 92% of its budget',
          body: '$460 of $500 spent this month, in the household’s budget.',
        },
      ]);
    }
  });

  it('reminds of a card statement on cards they own', async () => {
    const { householdId, alex, sam } = await household();
    const card = await h.account({
      householdId,
      owners: [alex],
      name: 'Harbor Visa',
      type: 'credit',
    });
    await h.owner.query(
      `INSERT INTO account_liabilities (account_id, household_id, minimum_payment_minor,
         next_due_date, last_statement_balance_minor, last_statement_date)
       VALUES ($1, $2, 3500, $3, -84210, $4)`,
      [card, householdId, addDays(TODAY, 3), addDays(TODAY, -20)],
    );
    await rules().runHousehold(householdId, AT(9), { daily: true });
    expect(await sent(alex, 'statement_due')).toMatchObject([
      {
        title: expect.stringMatching(/^Harbor Visa statement is due on /),
        body: '$842.10 to pay, $35 at least.',
      },
    ]);
    expect(await sent(sam, 'statement_due')).toEqual([]);
  });

  it('says what’s waiting for review once a day, from their hour, and not to viewers', async () => {
    const { householdId, alex } = await household();
    const card = await h.account({ householdId, owners: [alex], name: 'Card' });
    await txn(householdId, card, -1_200, TODAY, 'Coffee', { reviewStatus: 'needs_review' });
    await txn(householdId, card, -1_300, TODAY, 'Lunch', { reviewStatus: 'needs_review' });
    const r = rules();
    await r.runHousehold(householdId, AT(8), { daily: false });
    expect(await sent(alex, 'review')).toEqual([]);
    await r.runHousehold(householdId, AT(9), { daily: false });
    await r.runHousehold(householdId, AT(10), { daily: false });
    expect(await sent(alex, 'review')).toMatchObject([
      { title: '2 transactions to review', link: `/h/${householdId}/review` },
    ]);
  });

  it('counts only the uncategorized ones when that’s all the household reviews (#508)', async () => {
    const { householdId, alex } = await household();
    const card = await h.account({ householdId, owners: [alex], name: 'Card' });
    await txn(householdId, card, -1_200, TODAY, 'Coffee', { reviewStatus: 'needs_review' });
    await txn(householdId, card, -1_300, TODAY, 'Lunch', { reviewStatus: 'needs_review' });
    await h.owner.query(
      `UPDATE transactions SET category_id = (SELECT id FROM categories
         WHERE household_id = $1 AND system_key IS NULL LIMIT 1)
       WHERE household_id = $1 AND display_name = 'Lunch'`,
      [householdId],
    );
    await h.owner.query(`UPDATE households SET review_scope = 'uncategorized' WHERE id = $1`, [
      householdId,
    ]);
    await rules().runHousehold(householdId, AT(9), { daily: false });
    expect(await sent(alex, 'review')).toMatchObject([{ title: '1 transaction to review' }]);
  });

  it('sends nothing for a rule unticked everywhere', async () => {
    const { householdId, alex } = await household();
    const mine = await h.account({ householdId, owners: [alex], name: 'Checking' });
    await series(householdId, mine, alex, { name: 'Rent', kind: 'bill', day: 1 });
    await h.owner.query(
      `INSERT INTO notification_preferences (household_id, member_id, kind, channels)
       VALUES ($1, $2, 'bill_due', '{}')`,
      [householdId, alex],
    );
    await rules().runHousehold(householdId, AT(9), { daily: true });
    expect(await sent(alex, 'bill_due')).toEqual([]);
  });

  it('runs each household on its own clock: daily rules once, from 8 in the morning (D20)', async () => {
    const { householdId, alex } = await household();
    await h.owner.query(`UPDATE households SET timezone = 'Pacific/Kiritimati' WHERE id = $1`, [
      householdId,
    ]);
    const mine = await h.account({ householdId, owners: [alex], name: 'Checking' });
    // 07:30 in Kiritimati (UTC+14) is 17:30 UTC the day before.
    let now = new Date('2026-11-11T17:30:00Z');
    const local = localTime('Pacific/Kiritimati', now);
    expect(local).toMatchObject({ date: '2026-11-12', hour: 7 });
    await h.owner.query(
      `INSERT INTO recurring_series (id, household_id, account_id, name, kind, match, schedule,
         created_by_member_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'Rent', 'bill', '{"direction":"out"}',
         '{"unit":"day","every":30,"anchor":"2026-11-13","weekend":"as_is"}', $3, '2025-01-01')`,
      [householdId, mine, alex],
    );
    const r = new NotificationRules(h.worker.db, { now: () => now, checkEveryMs: 0 }, quiet);
    await r.pass();
    expect(await sent(alex, 'bill_due')).toEqual([]);
    now = new Date('2026-11-11T18:05:00Z'); // 08:05 there
    await r.pass();
    await r.pass();
    now = new Date('2026-11-11T19:05:00Z');
    await r.pass();
    expect((await sent(alex, 'bill_due')).map((n) => n.title)).toEqual(['Rent is due tomorrow']);
  });

  it('says a price went up, or a subscription is new, once, to those who see it [SYS-02] (D14)', async () => {
    const { householdId, alex, sam } = await household();
    const joint = await h.account({
      householdId,
      owners: [alex, sam],
      name: 'Joint card',
      type: 'credit',
    });
    const alexs = await h.account({
      householdId,
      owners: [alex],
      name: 'Alex’s card',
      type: 'credit',
      visibility: 'private',
    });
    // Every 30 days: $15.49 five times, then $20.49 the last two.
    await series(householdId, joint, alex, { name: 'Streamly', kind: 'subscription', day: 0 });
    for (const [back, amount] of [
      [210, 1_549],
      [180, 1_549],
      [150, 1_549],
      [120, 1_549],
      [90, 1_549],
      [60, 2_049],
      [30, 2_049],
    ] as const) {
      await txn(householdId, joint, -amount, addDays(TODAY, -back), 'Streamly');
    }
    // Alex's own card: a subscription first paid 30 days ago.
    await series(householdId, alexs, alex, { name: 'Canvas Plus', kind: 'subscription', day: 0 });
    await txn(householdId, alexs, -999, addDays(TODAY, -30), 'Canvas Plus');
    const r = rules();
    await r.runHousehold(householdId, AT(9), { daily: true });
    await r.runHousehold(householdId, AT(10), { daily: true });
    const titles = async (m: string) =>
      (await sent(m, 'subscription_change')).map((n) => n.title).sort();
    expect(await titles(alex)).toEqual([
      'Canvas Plus looks like a new subscription',
      'Streamly went up $5',
    ]);
    expect(await titles(sam)).toEqual(['Streamly went up $5']);
    expect(JSON.stringify(await sent(sam))).not.toMatch(/Canvas|Alex’s card/);
  });

  describe('the weekly recap (#128, D21)', () => {
    const MONDAY = { date: '2026-11-09', hour: 8, weekday: 'monday' };
    const recaps = async (memberId: string) =>
      (
        await h.owner.query(
          `SELECT title, body, summary, link, dedupe_key, email FROM notifications
           WHERE member_id = $1 AND kind = 'weekly_recap'`,
          [memberId],
        )
      ).rows;

    it('sends each member their recap once a week, at their day and hour there', async () => {
      const { householdId, alex, sam } = await household();
      const r = rules();
      await r.runHousehold(householdId, { ...MONDAY, hour: 7 }, { daily: false });
      await r.runHousehold(
        householdId,
        { ...MONDAY, date: '2026-11-10', weekday: 'tuesday' },
        {
          daily: false,
        },
      );
      expect(await recaps(alex)).toEqual([]);
      await r.runHousehold(householdId, MONDAY, { daily: false });
      await r.runHousehold(householdId, { ...MONDAY, hour: 9 }, { daily: false });
      await rules().runHousehold(householdId, { ...MONDAY, hour: 10 }, { daily: false });
      for (const m of [alex, sam]) {
        const [recap, ...more] = await recaps(m);
        expect(more).toEqual([]);
        // A quiet week still sends: it's clear nothing broke.
        expect(recap).toMatchObject({
          title: 'Your week, Nov 2–8',
          summary: 'Your weekly recap is ready.',
          link: `/h/${householdId}`,
          dedupe_key: 'weekly_recap:2026-11-02',
        });
        expect(recap.body).toMatch(/^A quiet week/);
        for (const detail of ['full', 'summary', 'minimal']) {
          expect(recap.email[detail].subject).toBeTruthy();
          expect(recap.email[detail].html).toContain('<html');
        }
      }
    });

    it('follows their day and hour', async () => {
      const { householdId, alex } = await household();
      await prefer(alex, householdId, 'weekly_recap', { day: 'friday', hour: 17 });
      await rules().runHousehold(householdId, MONDAY, { daily: false });
      expect(await recaps(alex)).toEqual([]);
      await rules().runHousehold(
        householdId,
        { date: '2026-11-13', hour: 17, weekday: 'friday' },
        { daily: false },
      );
      expect((await recaps(alex)).map((n) => n.dedupe_key)).toEqual(['weekly_recap:2026-11-02']);
    });

    it('builds each recap from what its reader sees [SYS-02]', async () => {
      const { householdId, alex, sam } = await household();
      const samsCard = await h.account({
        householdId,
        owners: [sam],
        name: 'Sam’s card',
        type: 'credit',
        visibility: 'private',
      });
      await txn(householdId, samsCard, -61_200, '2026-11-04', 'Jeweler');
      await rules().runHousehold(householdId, MONDAY, { daily: false });
      const [alexs] = await recaps(alex);
      const [sams] = await recaps(sam);
      expect(JSON.stringify(sams.email.full)).toContain('Jeweler');
      expect(JSON.stringify(alexs)).not.toMatch(/Jeweler|Sam’s card|612/);
    });

    it('is left out when turned off', async () => {
      const { householdId, alex } = await household();
      await rules().runHousehold(householdId, MONDAY, { daily: false });
      const off = new NotificationRules(h.worker.db, { recap: false }, quiet);
      const { householdId: other, memberId } = await h.household();
      await off.runHousehold(other, MONDAY, { daily: false });
      expect(await recaps(memberId)).toEqual([]);
      expect(await recaps(alex)).toHaveLength(1);
    });
  });
});
