// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { startMaintenance, systemContext, verifyChain, withContext } from '@fiscus/db';
import { HouseholdActivity } from '@fiscus/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkerHarness, type WorkerHarness } from '../testing/harness.js';
import { MemberMoves } from './member-moves.js';

/**
 * Moving out (#253, ADR 0012 step 3), as the worker does it: Sam moves out of Ada's household into
 * one of their own, taking what's theirs with its ids, re-encrypted with the new household's key.
 */

const silent = { log: () => {}, warn: () => {}, error: () => {} };

describe('moving out', () => {
  let h: WorkerHarness;
  let moves: MemberMoves;

  beforeAll(async () => {
    h = await startWorkerHarness();
    moves = new MemberMoves(h.worker.db, h.crypto, {}, silent);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await h.owner.query(text, values)).rows as T[];
  const one = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await q<T>(text, values))[0]!;

  /** Sam in Ada's household, and a household of Sam's own for the move, as the api makes them. */
  async function setUp() {
    const old = await h.household();
    const ada = old.memberId;
    const sam = await h.member(old.householdId, 'Sam', 'member');
    const { user_id: samUser } = await one<{ user_id: string }>(
      'SELECT user_id FROM household_members WHERE id = $1',
      [sam],
    );
    const next = await h.household();
    // The new household's owner is Sam: the same login.
    await h.owner.query('UPDATE household_members SET user_id = $1 WHERE id = $2', [
      samUser,
      next.memberId,
    ]);
    const moveId = randomUUID();
    await h.owner.query(
      `INSERT INTO member_moves (id, household_id, member_id, from_household_id, from_member_id,
         final_balances)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        moveId,
        next.householdId,
        next.memberId,
        old.householdId,
        sam,
        JSON.stringify([{ memberId: ada, displayName: 'A', amountMinor: 1250, currency: 'USD' }]),
      ],
    );
    return { H: old.householdId, N: next.householdId, ada, sam, samNew: next.memberId, moveId };
  }

  const category = (householdId: string, name: string) =>
    one<{ id: string }>('SELECT id FROM categories WHERE household_id = $1 AND name = $2', [
      householdId,
      name,
    ]).then((r) => r.id);

  const txn = async (
    householdId: string,
    accountId: string,
    amount: number,
    extra: Record<string, unknown> = {},
  ) => {
    const id = randomUUID();
    const cols = Object.keys(extra);
    await h.owner.query(
      `INSERT INTO transactions (id, household_id, account_id, amount_minor, currency,
         authorized_date, posted_date, original_description, display_name, source
         ${cols.map((c) => `, ${c}`).join('')})
       VALUES ($1, $2, $3, $4, 'USD', '2026-11-01', '2026-11-01', 'X', 'X', 'manual'
         ${cols.map((_, i) => `, $${i + 5}`).join('')})`,
      [id, householdId, accountId, amount, ...Object.values(extra)],
    );
    return id;
  };

  const note = async (
    householdId: string,
    transactionId: string,
    author: string | null,
    body: string,
  ) => {
    const bodyEnc = await h.crypto.encrypt(
      {
        householdId,
        table: 'transaction_notes',
        column: 'body_enc',
        rowId: `${transactionId}:${author ?? 'shared'}`,
      },
      body,
    );
    await h.owner.query(
      `INSERT INTO transaction_notes (id, household_id, transaction_id, author_member_id, body_enc,
         updated_by_member_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), householdId, transactionId, author, bodyEnc, author ?? randomUUID()],
    );
  };

  it('moves what they own alone with its history, keeps joint accounts, and leaves', async () => {
    const { H, N, ada, sam, samNew, moveId } = await setUp();

    // Sam's bank login, with the server's keys, behind their checking and the joint account.
    const login = await h.connection({ householdId: H, ownerMemberId: sam, next: null });
    // A household-key connection (ADR 0008): can't move, so it's re-linked there.
    const { rows: keys } = await h.owner.query(
      `INSERT INTO aggregation_credentials (id, household_id, provider, client_id, secret_enc, env)
       VALUES ($1, $2, 'plaid', 'client', '\\x00', 'sandbox') RETURNING id`,
      [randomUUID(), H],
    );
    const householdKeys = await h.connection({
      householdId: H,
      ownerMemberId: sam,
      next: null,
      credentialSetId: keys[0].id as string,
    });
    const checking = await h.account({
      householdId: H,
      owners: [sam],
      name: 'Checking',
      connectionId: login,
      providerAccountId: 'p-checking',
    });
    const savings = await h.account({
      householdId: H,
      owners: [sam],
      name: 'Savings',
      connectionId: householdKeys,
      providerAccountId: 'p-savings',
    });
    const joint = await h.account({
      householdId: H,
      owners: [sam, ada],
      name: 'Joint',
      connectionId: login,
      providerAccountId: 'p-joint',
    });
    const adas = await h.account({ householdId: H, owners: [ada], name: 'Ada’s card' });
    const notesEnc = await h.crypto.encrypt(
      { householdId: H, table: 'accounts', column: 'notes_enc', rowId: checking },
      'branch on Main St',
    );
    await h.owner.query('UPDATE accounts SET notes_enc = $1 WHERE id = $2', [notesEnc, checking]);
    await h.owner.query(
      `INSERT INTO balance_snapshots (account_id, as_of, household_id, balance_minor, source)
       VALUES ($1, '2026-11-01', $2, 50000, 'manual')`,
      [checking, H],
    );

    const groceries = await category(H, 'Groceries');
    const { rows: g } = await h.owner.query(
      `INSERT INTO category_groups (id, household_id, name, kind) VALUES ($1, $2, 'Hobbies', 'flexible')
       RETURNING id`,
      [randomUUID(), H],
    );
    const boat = randomUUID();
    await h.owner.query(
      `INSERT INTO categories (id, household_id, group_id, name) VALUES ($1, $2, $3, 'Boat')`,
      [boat, H, g[0].id],
    );
    const tag = randomUUID();
    await h.owner.query(
      `INSERT INTO tags (id, household_id, name, color) VALUES ($1, $2, 'Trips', '#123456')`,
      [tag, H],
    );

    // A purchase for Ada on Sam's card, with notes from each of them and a tag.
    const forAda = await txn(H, checking, -4000, { category_id: groceries });
    await h.owner.query(
      `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps)
       VALUES ($1, $2, $3, 10000)`,
      [forAda, ada, H],
    );
    await h.owner.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id, household_id) VALUES ($1, $2, $3)`,
      [forAda, tag, H],
    );
    await note(H, forAda, null, 'the shared one');
    await note(H, forAda, sam, 'Sam’s own');
    await note(H, forAda, ada, 'Ada’s own');
    const onBoat = await txn(H, checking, -9000, { category_id: boat });
    // A transfer from Sam's checking into the joint account: the link goes, both sides.
    const group = randomUUID();
    const out = await txn(H, checking, -20000, { transfer_group_id: group });
    const into = await txn(H, joint, 20000, { transfer_group_id: group });
    // Ada paid Sam back by transfer into Sam's checking: the settle-up stays, paid another way.
    const repaid = await txn(H, checking, 1500, { is_settlement: true });
    await h.owner.query(
      `INSERT INTO settlements (id, household_id, from_member_id, to_member_id, amount_minor, date,
         kind, transaction_id, created_by_member_id)
       VALUES ($1, $2, $3, $4, 1500, '2026-11-02', 'transfer', $5, $3)`,
      [randomUUID(), H, ada, sam, repaid],
    );
    // Something of Ada's, attributed to Sam: it stays.
    const adasPurchase = await txn(H, adas, -700);

    // Sam's own budget, goals and rule; the household's goal on Sam's savings.
    const budget = randomUUID();
    await h.owner.query(
      `INSERT INTO budgets (id, household_id, member_id, starts_month) VALUES ($1, $2, $3, '2026-11-01');
       INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
         VALUES ($2, $1, '2026-11-01', $4, 30000);
       INSERT INTO budget_templates (id, household_id, budget_id, name, amounts)
         VALUES (gen_random_uuid(), $2, $1, 'Lean', jsonb_build_object($4::text, 20000))`
        .replaceAll('$1', `'${budget}'`)
        .replaceAll('$2', `'${H}'`)
        .replaceAll('$3', `'${sam}'`)
        .replaceAll('$4', `'${groceries}'`),
    );
    const trip = randomUUID();
    const house = randomUUID();
    await h.owner.query(
      `INSERT INTO goals (id, household_id, member_id, name, target_minor) VALUES
         ($1, $3, $4, 'Trip', 100000), ($2, $3, NULL, 'House', 1000000);
       INSERT INTO goal_claims (id, household_id, goal_id, account_id, amount_minor) VALUES
         (gen_random_uuid(), $3, $1, $5, 10000), (gen_random_uuid(), $3, $1, $6, 5000),
         (gen_random_uuid(), $3, $2, $5, 20000);`
        .replaceAll('$1', `'${trip}'`)
        .replaceAll('$2', `'${house}'`)
        .replaceAll('$3', `'${H}'`)
        .replaceAll('$4', `'${sam}'`)
        .replaceAll('$5', `'${savings}'`)
        .replaceAll('$6', `'${joint}'`),
    );
    const rule = randomUUID();
    await h.owner.query(
      `INSERT INTO rules (id, household_id, member_id, author_member_id, position, conditions, actions)
       VALUES ($1, $2, $3, $3, 1, $4, $5)`,
      [
        rule,
        H,
        sam,
        JSON.stringify({ accountIds: [checking, joint] }),
        JSON.stringify({ categoryId: groceries, addTagIds: [tag] }),
      ],
    );
    await h.owner.query(
      `INSERT INTO transaction_attributions (transaction_id, member_id, household_id, share_bps)
       VALUES ($1, $2, $3, 10000)`,
      [adasPurchase, sam, H],
    );

    // Something that happened to Sam's checking before: it stays in Ada's household's history.
    await withContext(h.worker.db, systemContext(H), (tx) =>
      new HouseholdActivity(
        tx,
        H,
        { kind: 'system', userId: null, memberId: null },
        h.crypto,
      ).record({
        action: 'account.updated',
        targetType: 'account',
        targetId: checking,
        accountId: checking,
      }),
    );

    // Stopped after copying, then carried on: as after a crash.
    expect(await moves.run(moveId, { stopAfter: 2 })).toBe(false);
    expect(await one('SELECT status, step FROM member_moves WHERE id = $1', [moveId])).toEqual({
      status: 'moving',
      step: 2,
    });
    expect(await moves.run(moveId)).toBe(true);
    expect(await moves.run(moveId)).toBe(false);
    expect(
      await one(
        'SELECT status, step, finished_at IS NOT NULL AS finished FROM member_moves WHERE id = $1',
        [moveId],
      ),
    ).toEqual({ status: 'done', step: 5, finished: true });

    // Accounts: theirs alone moved with their ids, history and connection; the joint one stayed.
    const accounts = await q<{ id: string; household_id: string; connection_id: string | null }>(
      'SELECT id, household_id, connection_id FROM accounts WHERE id = ANY ($1) ORDER BY name',
      [[checking, savings, joint, adas]],
    );
    expect(
      Object.fromEntries(accounts.map((a) => [a.id, [a.household_id, a.connection_id]])),
    ).toEqual({
      [checking]: [N, login],
      [savings]: [N, null],
      [joint]: [H, null],
      [adas]: [H, null],
    });
    expect(
      await q(
        'SELECT account_id, member_id, share_bps FROM account_owners WHERE account_id = ANY ($1) ORDER BY share_bps',
        [[checking, savings, joint]],
      ),
    ).toEqual(
      expect.arrayContaining([
        { account_id: checking, member_id: samNew, share_bps: 10000 },
        { account_id: savings, member_id: samNew, share_bps: 10000 },
        { account_id: joint, member_id: ada, share_bps: 10000 },
      ]),
    );
    // The joint account's earlier days keep both of them as owners.
    expect(
      await q(
        'SELECT member_id, share_bps FROM account_owner_periods WHERE account_id = $1 ORDER BY member_id',
        [joint],
      ),
    ).toHaveLength(2);
    const [notes] = await q<{ notes_enc: Buffer }>('SELECT notes_enc FROM accounts WHERE id = $1', [
      checking,
    ]);
    expect(
      await h.crypto.decrypt(
        { householdId: N, table: 'accounts', column: 'notes_enc', rowId: checking },
        notes!.notes_enc,
      ),
    ).toBe('branch on Main St');
    expect(
      await one('SELECT household_id FROM balance_snapshots WHERE account_id = $1', [checking]),
    ).toEqual({ household_id: N });

    // Connections: the server's keys moved with the secret re-encrypted; the household's ended.
    expect(
      await one('SELECT household_id, owner_member_id FROM connections WHERE id = $1', [login]),
    ).toEqual({ household_id: N, owner_member_id: samNew });
    const { secret_enc } = await one<{ secret_enc: Buffer }>(
      'SELECT secret_enc FROM connection_secrets WHERE connection_id = $1',
      [login],
    );
    expect(
      await h.crypto.decrypt(
        { householdId: N, table: 'connection_secrets', column: 'secret_enc', rowId: login },
        secret_enc,
      ),
    ).toBe('fake-secret');
    expect(
      await one(
        'SELECT household_id, status, disconnect_requested FROM connections WHERE id = $1',
        [householdKeys],
      ),
    ).toEqual({ household_id: H, status: 'disconnected', disconnect_requested: true });

    // Transactions: same ids, categories matched or copied, tags copied.
    const newGroceries = await category(N, 'Groceries');
    const { category_id: newBoat } = await one<{ category_id: string }>(
      'SELECT category_id FROM transactions WHERE id = $1',
      [onBoat],
    );
    expect(
      await one(
        `SELECT c.household_id, c.name, g.name AS group_name FROM categories c
         JOIN category_groups g ON g.id = c.group_id WHERE c.id = $1`,
        [newBoat],
      ),
    ).toEqual({ household_id: N, name: 'Boat', group_name: 'Hobbies' });
    expect(
      await one('SELECT household_id, category_id FROM transactions WHERE id = $1', [forAda]),
    ).toEqual({ household_id: N, category_id: newGroceries });
    const { tag_id: newTag } = await one<{ tag_id: string }>(
      'SELECT tag_id FROM transaction_tags WHERE transaction_id = $1',
      [forAda],
    );
    expect(await one('SELECT household_id, name FROM tags WHERE id = $1', [newTag])).toEqual({
      household_id: N,
      name: 'Trips',
    });
    // The old household keeps its own categories and tags.
    expect(await one('SELECT household_id FROM tags WHERE id = $1', [tag])).toEqual({
      household_id: H,
    });
    // Who it was for: theirs now. Ada's private note went; the shared one and Sam's moved.
    expect(
      await q('SELECT 1 FROM transaction_attributions WHERE transaction_id = $1', [forAda]),
    ).toEqual([]);
    const moved = await q<{
      author_member_id: string | null;
      body_enc: Buffer;
      household_id: string;
    }>(
      'SELECT author_member_id, body_enc, household_id FROM transaction_notes WHERE transaction_id = $1 ORDER BY author_member_id NULLS FIRST',
      [forAda],
    );
    expect(moved.map((n) => [n.household_id, n.author_member_id])).toEqual([
      [N, null],
      [N, samNew],
    ]);
    const bodies = await Promise.all(
      moved.map((n) =>
        h.crypto.decrypt(
          {
            householdId: N,
            table: 'transaction_notes',
            column: 'body_enc',
            rowId: `${forAda}:${n.author_member_id ?? 'shared'}`,
          },
          n.body_enc,
        ),
      ),
    );
    expect(bodies).toEqual(['the shared one', 'Sam’s own']);
    // The transfer's two sides are in different households now: each is one-sided.
    expect(
      await q(
        'SELECT id, household_id, transfer_group_id, transfer_external FROM transactions WHERE id = ANY ($1) ORDER BY amount_minor',
        [[out, into]],
      ),
    ).toEqual([
      { id: out, household_id: N, transfer_group_id: null, transfer_external: true },
      { id: into, household_id: H, transfer_group_id: null, transfer_external: true },
    ]);
    // The settle-up stays with Ada's household, as paid another way.
    expect(
      await one(
        'SELECT household_id, kind, transaction_id FROM settlements WHERE from_member_id = $1',
        [ada],
      ),
    ).toEqual({ household_id: H, kind: 'paid', transaction_id: null });
    // Ada's purchase that was for Sam stays where it is.
    expect(
      await one('SELECT household_id FROM transactions WHERE id = $1', [adasPurchase]),
    ).toEqual({
      household_id: H,
    });

    // Budget, goals and rule.
    expect(
      await one('SELECT household_id, member_id FROM budgets WHERE id = $1', [budget]),
    ).toEqual({
      household_id: N,
      member_id: samNew,
    });
    expect(
      await one('SELECT household_id, category_id FROM budget_amounts WHERE budget_id = $1', [
        budget,
      ]),
    ).toEqual({ household_id: N, category_id: newGroceries });
    expect(
      await one('SELECT amounts FROM budget_templates WHERE budget_id = $1', [budget]),
    ).toEqual({
      amounts: { [newGroceries]: 20000 },
    });
    expect(await one('SELECT household_id, member_id FROM goals WHERE id = $1', [trip])).toEqual({
      household_id: N,
      member_id: samNew,
    });
    expect(
      await q('SELECT household_id, account_id FROM goal_claims WHERE goal_id = $1', [trip]),
    ).toEqual([{ household_id: N, account_id: savings }]);
    expect(
      await q(
        "SELECT household_id, account_id FROM goal_claim_events WHERE reason = 'ended' ORDER BY household_id = $1",
        [N],
      ),
    ).toEqual([
      { household_id: H, account_id: savings },
      { household_id: N, account_id: joint },
    ]);
    expect(await one('SELECT household_id FROM goals WHERE id = $1', [house])).toEqual({
      household_id: H,
    });
    expect(await q('SELECT 1 FROM goal_claims WHERE goal_id = $1', [house])).toEqual([]);
    expect(
      await one('SELECT household_id, member_id, conditions, actions FROM rules WHERE id = $1', [
        rule,
      ]),
    ).toEqual({
      household_id: N,
      member_id: samNew,
      conditions: { accountIds: [checking] },
      actions: { categoryId: newGroceries, addTagIds: [newTag] },
    });

    // They've left, both households say so, and Ada is told.
    expect(
      await one('SELECT left_at IS NOT NULL AS gone FROM household_members WHERE id = $1', [sam]),
    ).toEqual({ gone: true });
    const actions = async (householdId: string) =>
      (
        await q<{ action: string }>(
          'SELECT action FROM audit_events WHERE household_id = $1 ORDER BY seq',
          [householdId],
        )
      ).map((r) => r.action);
    expect(await actions(H)).toEqual(
      expect.arrayContaining(['account.moved_out', 'account.owners_changed', 'member.moved_out']),
    );
    expect(await actions(N)).toEqual(
      expect.arrayContaining([
        'member_move.planned',
        'member_move.copied',
        'account.moved_in',
        'budget.moved_in',
        'member_move.moved',
        'member_move.done',
      ]),
    );
    // Each history is intact, events about the accounts that moved included (members verify it
    // through fiscus_household_chain(), which sees every event, as this does).
    const session = await startMaintenance(h.worker.db, { job: 'member-move', reason: 'test' });
    for (const id of [H, N]) {
      expect((await session.transaction((tx) => verifyChain(tx, id))).ok).toBe(true);
    }
    expect(
      await q(
        "SELECT member_id FROM notifications WHERE kind = 'member_moved_out' AND household_id = $1",
        [H],
      ),
    ).toEqual([{ member_id: ada }]);
  });

  it('refuses the last owner before anything moves, and says why', async () => {
    const { H, sam, moveId } = await setUp();
    // Sam is the only owner now.
    await h.owner.query(
      `UPDATE household_members SET role = CASE WHEN id = $1 THEN 'owner' ELSE 'member' END::member_role
       WHERE household_id = $2`,
      [sam, H],
    );
    const account = await h.account({ householdId: H, owners: [sam] });
    await expect(moves.run(moveId)).rejects.toThrow(/last_owner/);
    expect(
      await one('SELECT status, error_code, step FROM member_moves WHERE id = $1', [moveId]),
    ).toEqual({ status: 'failed', error_code: 'last_owner', step: 0 });
    expect(await one('SELECT household_id FROM accounts WHERE id = $1', [account])).toEqual({
      household_id: H,
    });
    expect(await one('SELECT left_at FROM household_members WHERE id = $1', [sam])).toEqual({
      left_at: null,
    });
  });

  it('carries on with due moves from the queue, once each', async () => {
    const { moveId } = await setUp();
    expect(await moves.pass()).toBeGreaterThanOrEqual(1);
    expect(await one('SELECT status FROM member_moves WHERE id = $1', [moveId])).toEqual({
      status: 'done',
    });
    expect(await moves.pass()).toBe(0);
  });
});
