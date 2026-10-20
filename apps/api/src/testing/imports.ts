// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  chunkRowsByDate,
  type ImportBalance,
  type ImportFormat,
  type ImportPreview,
  type ImportRowResult,
  type ImportRun,
  type ImportTransaction,
} from '@fiscus/shared';
import type { TestClient } from './test-app.js';

type Res = Awaited<ReturnType<TestClient['request']>>;

export interface ImportBody {
  format: ImportFormat;
  filename: string;
  accounts: { key: string; [k: string]: unknown }[];
  categories?: { name: string; categoryId?: string; kind?: string }[];
  members?: { name: string; memberId: string | null }[];
  transactions?: ImportTransaction[];
  balances?: ImportBalance[];
  includeOverlaps?: number[];
}

export interface ImportOutcome {
  /** The first response that failed, or the last one. */
  res: Res;
  preview: ImportPreview;
  run: ImportRun | null;
  added: number;
  balances: number;
  rows: ImportRowResult[];
}

/**
 * Imports a file the way the wizard does: preview, start a run, then each account's rows in
 * parts (a day never split), with its balances last.
 */
export async function runImport(
  c: TestClient,
  base: string,
  body: ImportBody,
  partSize = 5_000,
): Promise<ImportOutcome> {
  const transactions = body.transactions ?? [];
  const balances = body.balances ?? [];
  const preview = await c.post(`${base}/imports/preview`, body);
  const out: ImportOutcome = {
    res: preview,
    preview: preview.body.data,
    run: null,
    added: 0,
    balances: 0,
    rows: [],
  };
  if (preview.status >= 300) return out;
  const start = await c.post(`${base}/imports`, {
    format: body.format,
    filename: body.filename,
    accounts: body.accounts,
    members: body.members ?? [],
    // New categories keep the kind the preview worked out.
    categories: [
      ...(body.categories ?? []),
      ...out.preview.newCategories.map((n) => ({ name: n.name, kind: n.kind })),
    ],
    categoryNames: [...new Set(transactions.map((t) => t.category).filter((n) => !!n))],
    tags: [...new Set(transactions.flatMap((t) => t.tags ?? []))],
  });
  out.res = start;
  if (start.status >= 300) return out;
  out.run = start.body.data;
  for (const batch of out.run!.batches) {
    const mine = transactions.filter((t) => t.account === batch.key);
    const parts: Record<string, unknown>[] = chunkRowsByDate(mine, partSize).map((part) => ({
      transactions: part.map(({ account: _, ...row }) => row),
      includeOverlaps: (body.includeOverlaps ?? []).filter((l) => part.some((r) => r.line === l)),
    }));
    const bal = balances.filter((b) => b.account === batch.key).map(({ account: _, ...b }) => b);
    if (bal.length) parts.push({ balances: bal });
    for (const part of parts) {
      const r = await c.post(`${base}/imports/${batch.batchId}/rows`, part);
      out.res = r;
      if (r.status >= 300) return out;
      out.added += r.body.data.added;
      out.balances += r.body.data.balances;
      out.rows.push(...r.body.data.rows);
    }
  }
  out.rows.sort((a, b) => a.line - b.line);
  return out;
}
