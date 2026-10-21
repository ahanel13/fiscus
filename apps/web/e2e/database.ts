// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';

// Direct database access for the tests that play a hostile operator (#264). It goes through the
// compose stack the tests run against: `docker compose -p <project> exec`, so it needs the docker
// CLI where Playwright runs. The project is E2E_COMPOSE_PROJECT, or `fiscus`, the name
// deploy/compose/docker-compose.yml gives itself (what CI runs).
const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? 'fiscus';

function compose(args: string[], input?: string): string {
  return execFileSync('docker', ['compose', '-p', PROJECT, ...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
    timeout: 60_000,
  });
}

/**
 * Runs in the api container, which has @fiscus/db, as the database owner: edits an entry of the
 * household's history, then recomputes every leaf, every link, and the head after it the way
 * appendActivity does, and checks the result with verifyChain. So the server's own check still
 * passes, and only a witness outside the database can tell.
 */
const REWRITE = `
import { createHash } from 'node:crypto';
import { auditChainHeads, auditEvents, canonical, createDb, verifyChain } from '@fiscus/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

const householdId = process.env.REWRITE_HOUSEHOLD;
const sha256 = (...parts) => parts.reduce((h, p) => h.update(p), createHash('sha256')).digest();
const { db, close } = createDb(process.env.REWRITE_DATABASE_URL, { max: 1 });
try {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.scopeId, householdId), isNotNull(auditEvents.seq)))
      .orderBy(asc(auditEvents.seq));
    if (!rows.length || rows.some((r) => r.hashVersion !== 2)) throw new Error('Not a v2 chain');
    let previous = Buffer.alloc(32);
    for (const row of rows) {
      // The edit: the first entry now says something it didn't, differently each time.
      const metadata = row.seq === 1 ? { ...row.metadata, rewrittenAt: Date.now() } : row.metadata;
      const leaf = sha256(
        canonical({
          scopeId: householdId,
          seq: row.seq,
          occurredAt: row.occurredAt,
          actorKind: row.actorKind,
          actorUserId: row.actorUserId,
          actorMemberId: row.actorMemberId,
          householdId: row.householdId,
          action: row.action,
          targetType: row.targetType,
          targetId: row.targetId,
          ...(row.accountId ? { accountId: row.accountId } : {}),
          visibleToHousehold: row.visibleToHousehold,
          metadata,
          ip: row.ip,
          changesEnc: row.changesEnc,
          hashVersion: 2,
        }),
      );
      previous = sha256(previous, leaf);
      await tx
        .update(auditEvents)
        .set({ metadata, leaf, entryHash: previous })
        .where(eq(auditEvents.id, row.id));
    }
    await tx
      .update(auditChainHeads)
      .set({ headHash: previous })
      .where(eq(auditChainHeads.scopeId, householdId));
    const check = await verifyChain(tx, householdId);
    if (!check.ok) throw new Error('The rewritten chain doesn’t verify: ' + JSON.stringify(check));
    console.log(JSON.stringify({ seq: check.seq, hash: check.headHash }));
  });
} finally {
  await close();
}
`;

/**
 * Rewrites a household's whole history consistently, as an operator with the database could: an
 * entry edited, and the chain recomputed from it, so `/verify` still says it's intact. Returns the
 * new head.
 */
export function rewriteHistory(householdId: string): { seq: number; hash: string } {
  // The owner's password, read from the db container and handed only to the api container.
  const password = compose(['exec', '-T', 'db', 'printenv', 'POSTGRES_PASSWORD']).trim();
  const out = compose(
    [
      'exec',
      '-T',
      '-e',
      `REWRITE_DATABASE_URL=postgres://fiscus_owner:${encodeURIComponent(password)}@db:5432/fiscus`,
      '-e',
      `REWRITE_HOUSEHOLD=${householdId}`,
      'api',
      'node',
      '--input-type=module',
    ],
    REWRITE,
  );
  return JSON.parse(out.trim().split('\n').at(-1)!) as { seq: number; hash: string };
}
