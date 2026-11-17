// SPDX-License-Identifier: AGPL-3.0-or-later
import { settlements } from '@fiscus/db';
import { startTestDatabase, type TestDatabase } from '@fiscus/db/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { createTestApp, TestClient } from '../testing/test-app.js';

/**
 * Settling with the fewest transfers (#262, D31), and what it may reveal (ADR 0006 §4, §7).
 *
 * Ada, Bea, Cy and Dee share a household; Val is a viewer. Bea paid for something of Ada's and
 * Bea's, so Ada owes Bea 40.00. Cy paid for something of Bea's and Cy's on a private card, so Bea
 * owes Cy 40.00. Ada can't see that one. With all three agreed, the plan is one payment, Ada to Cy,
 * instead of two. Dee never agrees, and nothing of Dee's reaches anyone's plan.
 */
describe('shared costs: the fewest transfers', () => {
  let tdb: TestDatabase;
  let app: NestFastifyApplication;
  const c: Record<'A' | 'B' | 'C' | 'D' | 'V', TestClient> = {} as never;
  const member = { A: '', B: '', C: '', D: '', V: '' };
  const user: Record<string, string> = {};
  const acct = { A: '', B: '', C: '', D: '' };
  let hh = '';
  let groceries = '';
  const url = (p = '') => `/api/v1/households/${hh}${p}`;
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const today = () => new Date().toISOString().slice(0, 10);

  /** A shared expense on `who`'s own card, for `forWho`. */
  const shared = async (
    who: 'A' | 'B' | 'C' | 'D',
    amountMinor: number,
    name: string,
    forWho: ('A' | 'B' | 'C' | 'D')[],
  ) => {
    const r = await c[who].post(url('/transactions'), {
      accountId: acct[who],
      date: today(),
      amountMinor: -amountMinor,
      displayName: name,
      categoryId: groceries,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const at = await c[who].request('PUT', url(`/transactions/${r.body.data.id}/attribution`), {
      attribution: forWho.map((k) => ({ memberId: member[k] })),
    });
    expect(at.status, JSON.stringify(at.body)).toBe(204);
    return r.body.data.id as string;
  };
  const costs = async (who: keyof typeof c) => {
    const r = await c[who].get(url(`/shared-costs?month=${thisMonth()}`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data;
  };
  const agree = async (who: keyof typeof c, agreed = true) =>
    c[who].request('PUT', url('/shared-costs/simplify'), { agreed });
  const pays = (from: keyof typeof member, to: keyof typeof member, amountMinor: number) => ({
    fromMemberId: member[from],
    toMemberId: member[to],
    amountMinor,
  });
  const ctxOf = (k: keyof typeof member): HouseholdContext => ({
    householdId: hh,
    memberId: member[k],
    role: 'member',
    userId: user[k]!,
  });

  beforeAll(async () => {
    tdb = await startTestDatabase();
    app = await createTestApp(tdb.appUrl, { signupMode: 'open' });
    const names = { A: 'ada', B: 'bea', C: 'cy', D: 'dee', V: 'val' } as const;
    for (const [k, name] of Object.entries(names) as [keyof typeof names, string][]) {
      c[k] = new TestClient(app);
      await c[k].post('/api/v1/auth/signup', {
        email: `${name}@fewest.test`,
        password: 'fewest test Password1!',
        displayName: name,
      });
    }
    hh = (
      await c.A.post('/api/v1/households', {
        name: 'Flat',
        baseCurrency: 'USD',
        timezone: 'UTC',
        financeStyle: 'roommates',
      })
    ).body.data.id;
    for (const k of ['B', 'C', 'D', 'V'] as const) {
      const invite = await c.A.post(url('/invites'), {
        email: `${names[k]}@fewest.test`,
        role: k === 'V' ? 'viewer' : 'member',
      });
      await c[k].post('/api/v1/invites/accept', {
        token: new URLSearchParams(new URL(invite.body.data.url).hash.slice(1)).get('token'),
      });
    }
    const db = new pg.Client({ connectionString: tdb.maintenanceUrl });
    await db.connect();
    try {
      const { rows } = await db.query<{ id: string; user_id: string; display_name: string }>(
        'SELECT id, user_id, display_name FROM household_members WHERE household_id = $1',
        [hh],
      );
      for (const r of rows) {
        const k = (Object.keys(names) as (keyof typeof names)[]).find(
          (x) => names[x] === r.display_name,
        )!;
        member[k] = r.id;
        user[k] = r.user_id;
      }
    } finally {
      await db.end();
    }
    for (const g of (await c.A.get(url('/categories'))).body.data as {
      categories: { id: string; name: string }[];
    }[]) {
      for (const x of g.categories) if (x.name === 'Groceries') groceries = x.id;
    }
    for (const k of ['A', 'B', 'C', 'D'] as const) {
      acct[k] = (
        await c[k].post(url('/accounts'), {
          name: `${names[k]} card`,
          type: 'depository',
          visibility: 'private',
        })
      ).body.data.id;
    }
    await shared('B', 8000, 'Bea paid for Ada and Bea', ['A', 'B']);
    await shared('C', 8000, 'Cy private dinner', ['B', 'C']);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await tdb?.stop();
  });

  it('shows no plan until you and at least two others agree', async () => {
    const a = await costs('A');
    expect(a.simplify).toEqual({ agreed: [], transfers: null });
    // Pairwise as always: Ada owes Bea, and knows nothing of Bea and Cy.
    expect(a.balances).toEqual([{ memberId: member.B, amountMinor: -4000 }]);
    expect((await agree('A')).status).toBe(204);
    expect((await agree('B')).status).toBe(204);
    const two = await costs('A');
    expect(two.simplify.agreed).toEqual([member.A, member.B].sort());
    expect(two.simplify.transfers).toBeNull();
  });

  it('[SHR-09/VIEW] a viewer can’t agree, and isn’t counted', async () => {
    expect((await agree('V')).status).toBe(403);
    expect((await costs('V')).simplify.transfers).toBeNull();
  });

  it('[SHR-09/OWN] [SHR-09/MEM] with three agreed, Ada pays Cy instead of Ada → Bea → Cy', async () => {
    expect((await agree('C')).status).toBe(204);
    // Agreeing twice changes nothing.
    expect((await agree('C')).status).toBe(204);
    const a = await costs('A');
    expect(a.simplify.agreed).toEqual([member.A, member.B, member.C].sort());
    expect(a.simplify.transfers).toEqual([pays('A', 'C', 4000)]);
    expect((await costs('C')).simplify.transfers).toEqual([pays('A', 'C', 4000)]);
    // Bea is square overall: nothing to pay or receive.
    expect((await costs('B')).simplify.transfers).toEqual([]);
    // The pairwise balances are still there, alongside.
    expect(a.balances).toEqual([{ memberId: member.B, amountMinor: -4000 }]);
  });

  it('shows each person only what they’re part of, and nothing of the expenses behind it', async () => {
    const a = JSON.stringify(await costs('A'));
    expect(a).not.toContain('Cy private dinner');
    // Ada learns Cy is owed (what agreeing allows), never by how much Bea and Cy are apart.
    const b = await costs('B');
    for (const t of b.simplify.transfers ?? []) {
      expect([t.fromMemberId, t.toMemberId]).toContain(member.B);
    }
  });

  it('someone who hasn’t agreed gets no plan, and their balances never reach anyone’s', async () => {
    const before = {
      A: (await costs('A')).simplify,
      B: (await costs('B')).simplify,
      C: (await costs('C')).simplify,
    };
    const dBefore = await costs('D');
    expect(dBefore.simplify.transfers).toBeNull();
    // Dee and Bea now have a balance (Bea owes Dee 25.00), and Ada and Dee one too.
    await shared('D', 5000, 'Dee paid for Bea and Dee', ['B', 'D']);
    await shared('A', 3000, 'Ada paid for Ada and Dee', ['A', 'D']);
    for (const k of ['A', 'B', 'C'] as const) {
      expect((await costs(k)).simplify).toEqual(before[k]);
    }
    // Bea's pairwise balance with Dee is there as always; only the plan leaves it out.
    expect((await costs('B')).balances).toContainEqual({ memberId: member.D, amountMinor: -2500 });
    const d = await costs('D');
    expect(d.simplify).toEqual({ agreed: before.A.agreed, transfers: null });
    expect(JSON.stringify(d)).not.toContain('Cy private dinner');
  });

  it('a settle-up on the plan squares everyone', async () => {
    const r = await c.A.post(url('/shared-costs/settlements'), {
      memberId: member.C,
      direction: 'you_paid',
      amountMinor: 4000,
      date: today(),
      kind: 'paid',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    for (const k of ['A', 'B', 'C'] as const) {
      expect((await costs(k)).simplify.transfers).toEqual([]);
    }
    await c.A.request('DELETE', url(`/shared-costs/settlements/${r.body.data.id}`));
    expect((await costs('A')).simplify.transfers).toEqual([pays('A', 'C', 4000)]);
  });

  it('stopping agreeing ends the plan for everyone, and is in the activity', async () => {
    expect((await agree('C', false)).status).toBe(204);
    for (const k of ['A', 'B', 'C'] as const) {
      expect((await costs(k)).simplify.transfers).toBeNull();
    }
    const feed = await c.A.get(url('/activity'));
    expect(JSON.stringify(feed.body)).toContain('settle_up.simplify_withdrawn');
    expect((await agree('C')).status).toBe(204);
  });

  describe('reading as someone who agreed (HouseholdScope.readAsAgreed)', () => {
    it('refuses anyone who hasn’t agreed, or when you haven’t', async () => {
      const scope = app.get(HouseholdScope);
      const read = (as: keyof typeof member, of: keyof typeof member) =>
        scope.readAsAgreed(ctxOf(as), member[of], async () => 'read');
      await expect(read('A', 'D')).rejects.toThrow(/agreed/);
      await expect(read('D', 'A')).rejects.toThrow(/agreed/);
      await expect(read('A', 'V')).rejects.toThrow(/agreed/);
      await expect(read('A', 'A')).rejects.toThrow(/agreed/);
      await expect(read('A', 'B')).resolves.toBe('read');
    });

    it('is read-only: nothing can be written as them', async () => {
      const scope = app.get(HouseholdScope);
      const error = await scope
        .readAsAgreed(ctxOf('A'), member.B, (tx) =>
          tx.insert(settlements).values({
            householdId: hh,
            fromMemberId: member.B,
            toMemberId: member.C,
            amountMinor: 1,
            date: today(),
            kind: 'paid',
            createdByMemberId: member.B,
          }),
        )
        .then(
          () => null,
          (e: Error) => e,
        );
      // Postgres refuses it: "cannot execute INSERT in a read-only transaction".
      expect(String((error?.cause as Error | undefined)?.message)).toMatch(/read-only/);
    });
  });
});
