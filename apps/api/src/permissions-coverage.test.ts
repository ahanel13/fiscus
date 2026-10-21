// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every rule in the permissions matrix (docs/design/permissions.md) is either tested for each
 * actor it names, or listed below as not built yet with where it lands. Adding a rule to the
 * matrix, or building one, fails this test until the tests catch up (permissions §7).
 *
 * Tests claim a cell with its key in the test name or source: `'TXN-04/VIEW'` or `[TXN-04/VIEW]`
 * for rules with OWN/MEM/VIEW columns, `[EDGE-06]` for the others.
 */
const NOT_BUILT: Record<string, string> = {
  'HH-07': 'Deleting a household (grace period, crypto-shred)',
  'HH-08': 'Household Plaid keys (M2)',
  'HH-09': 'Household AI settings (M10)',
  'HH-11': 'Owner audit log, separate from the activity feed',
  'HH-13': 'Data export (M11, #254)',
  'HH-14': 'History window for household-level records (#256, with budgets and settle-up)',
  'HH-15': 'Departure protection (#62)',
  'HH-16': 'Departure package (#62)',
  'HH-17': 'Ownership claims (#62)',
  'ACC-01': 'Bank connections (M2)',
  'ACC-10': 'Full account numbers (M2)',
  'TXN-07': 'Assigning reviewers (#45)',
  'TXN-11': 'Per-transaction edit history (#46)',
  'ATT-03': 'Flagging attribution changes (M3)',
  'ATT-04': 'Resolving flags (M3)',
  'RULE-02': 'Member-scoped rules (#58)',
  'RULE-04': 'Member-scoped rules (#58)',
  'TOK-01': 'Personal access tokens (M10)',
  'TOK-02': 'Personal access tokens (M10)',
  'TOK-03': 'Personal access tokens (M10)',
  'PAT-01': 'Personal access tokens (M10)',
  'PAT-02': 'Personal access tokens (M10)',
  'PAT-03': 'Personal access tokens (M10)',
  'SYS-01': 'Worker jobs (M2)',
  'SYS-02': 'Notifications and digests (M4)',
  'AI-01': 'AI assistant (M10)',
  'AI-02': 'AI assistant (M10)',
  'AI-03': 'AI assistant (M10)',
  'AI-04': 'MCP (M10)',
  'ADM-01': 'Instance admin console',
  'ADM-02': 'Instance admin console',
  'ADM-03': 'Instance admin console',
  'ADM-04': 'Instance admin console',
  // Bank connection settings are built (#400, admin/admin-settings.test.ts); signup mode, LLM,
  // FX and SMTP providers, webhooks and usage caps aren't yet, so the rule isn't claimed.
  'ADM-05': 'Instance settings beyond bank connections (#22, #84, M10)',
  'ADM-06': 'Instance admin console',
  'ADM-07': 'Usage: Plaid item counts (#400 part 2, after #78 and #81), AI usage (M10)',
  'EDGE-01': 'Departure flow (#62)',
  'EDGE-02': 'Departure flow (#62)',
  'EDGE-03': 'Departure flow (#62)',
  'EDGE-04': 'Personal access tokens (M10)',
  'EDGE-07': 'Instance admin console',
  'EDGE-09': 'Settle-up (M3)',
  'EDGE-12': 'Members without logins (#223)',
  'EDGE-13': 'Departure flow (#62)',
};

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ID = /(?:HH|ACC|TXN|ATT|NOTE|CAT|RULE|TOK|PAT|SYS|AI|ADM|EDGE)-\d+/;

/** Rule ids from the matrix, and which actors each must be tested as. */
function rules(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let actorColumns = false;
  for (const line of readFileSync(join(ROOT, 'docs/design/permissions.md'), 'utf8').split('\n')) {
    if (line.startsWith('| ID |')) actorColumns = /\| OWN \| MEM \| VIEW \|/.test(line);
    const id = line.match(new RegExp(`^\\| (${ID.source}) \\|`))?.[1];
    // A row with "—" for every actor is about the rule itself (RULE-05): one test covers it.
    const cells = line
      .split('|')
      .slice(3, 6)
      .map((c) => c.trim());
    const perActor = actorColumns && !cells.every((c) => c === '—');
    if (id) out.set(id, perActor ? ['OWN', 'MEM', 'VIEW'] : ['']);
  }
  return out;
}

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'node_modules' || e.name === 'dist'
        ? []
        : testFiles(join(dir, e.name))
      : e.name.endsWith('.test.ts')
        ? [join(dir, e.name)]
        : [],
  );
}

/** Cells claimed by tests: 'ROW/ACTOR' or [ROW/ACTOR] or [ROW]. */
function claimed(): Set<string> {
  const out = new Set<string>();
  const pattern = new RegExp(`['"\\[](${ID.source})(?:/(OWN|MEM|VIEW))?['"\\]]`, 'g');
  const files = [...testFiles(join(ROOT, 'apps')), ...testFiles(join(ROOT, 'packages'))];
  // This file names rules in NOT_BUILT; that's not a test of them.
  for (const file of files.filter((f) => !f.endsWith('permissions-coverage.test.ts'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(pattern)) {
      out.add(m[2] ? `${m[1]}/${m[2]}` : m[1]!);
    }
  }
  return out;
}

describe('permissions matrix coverage', () => {
  const matrix = rules();
  const tested = claimed();

  it('reads the matrix', () => {
    expect(matrix.size).toBeGreaterThan(80);
  });

  it('has a test for every actor of every built rule', () => {
    const missing = [...matrix]
      .filter(([id]) => !NOT_BUILT[id])
      .flatMap(([id, actors]) => actors.map((a) => (a ? `${id}/${a}` : id)))
      .filter((cell) => !tested.has(cell));
    expect(missing, 'Add tests named [ROW/ACTOR], or list the rule in NOT_BUILT').toEqual([]);
  });

  it('lists as not built only rules that exist and have no tests yet', () => {
    const stale = Object.keys(NOT_BUILT).filter(
      (id) =>
        !matrix.has(id) || [...tested].some((cell) => cell === id || cell.startsWith(`${id}/`)),
    );
    expect(
      stale,
      'Remove these from NOT_BUILT: they are tested now, or gone from the matrix',
    ).toEqual([]);
  });
});
