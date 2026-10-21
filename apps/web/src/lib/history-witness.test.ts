// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HistoryIntegrityReport, HistoryPoint } from '@fiscus/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import {
  acceptCurrentHistory,
  checkWitness,
  fingerprint,
  fold,
  runHistoryCheck,
  storedFailure,
  storedRebaselines,
  storedWitness,
  type Witness,
  type WitnessApi,
  witnessKey,
} from './history-witness.js';

const subtle = globalThis.crypto.subtle;
const GENESIS = '00'.repeat(32);

/**
 * The fixed vectors from packages/db/src/activity.test.ts: the browser's fold must reach the same
 * hashes as the server's foldLeaves. Change them only with a new hash version.
 */
describe('fold (the same vectors as @fiscus/db)', () => {
  const L1 = '11'.repeat(32);
  const L2 = '22'.repeat(32);
  const H1 = '8878b15a7d6a3a4f464e8f9f42591dbc0cf4bedea0ec309003d2b2ee53655ef8';
  const H2 = '78830000e1197790a7e1884139a65721210d642ad112e6c9899a05cb214027a5';

  it('folds leaves from a known hash to the head', async () => {
    expect(await fold(GENESIS, [], subtle)).toBe(GENESIS);
    expect(await fold(GENESIS, [L1], subtle)).toBe(H1);
    expect(await fold(GENESIS, [L1, L2], subtle)).toBe(H2);
    // Folding in pages is the same as folding at once.
    expect(await fold(await fold(GENESIS, [L1], subtle), [L2], subtle)).toBe(H2);
    // Order, a skipped leaf, and the starting point all matter.
    expect(await fold(GENESIS, [L2, L1], subtle)).not.toBe(H2);
    expect(await fold(GENESIS, [L2], subtle)).not.toBe(H2);
    expect(await fold(H1, [L1, L2], subtle)).not.toBe(H2);
  });

  it('uses the browser’s own SubtleCrypto by default', async () => {
    expect(await fold(GENESIS, [L1])).toBe(H1);
  });

  it('refuses anything but 32-byte lowercase hex', async () => {
    await expect(fold('00', [], subtle)).rejects.toThrow();
    await expect(fold(GENESIS, ['zz'.repeat(32)], subtle)).rejects.toThrow();
    await expect(fold(GENESIS, ['AB'.repeat(32)], subtle)).rejects.toThrow();
    await expect(fold(GENESIS, [`${L1}00`], subtle)).rejects.toThrow();
  });

  it('shortens a head to a fingerprint for comparing devices', () => {
    expect(fingerprint(H1)).toBe('8878 b15a');
  });
});

/** Leaf n of a test chain: 32 bytes of n. */
const leaf = (n: number) => (n % 256).toString(16).padStart(2, '0').repeat(32);

/** A chain of leaves (index 0 is entry 1) and the hash after each entry (index 0: genesis). */
async function chain(leaves: string[]) {
  const hashes = [GENESIS];
  for (const l of leaves) hashes.push(await fold(hashes.at(-1)!, [l], subtle));
  return { leaves, hashes, head: { seq: leaves.length, hash: hashes.at(-1)! } };
}

type Chain = Awaited<ReturnType<typeof chain>>;

/** The honest api over a chain, in pages of `pageSize`; any part can be replaced. */
function server(c: Chain, overrides: Partial<WitnessApi> = {}, pageSize = 5000) {
  const reports: HistoryIntegrityReport[] = [];
  const api: WitnessApi = {
    proof: async (from?: HistoryPoint) => {
      if (!from) return { data: { head: c.head, leaves: [] } };
      if (from.seq > c.head.seq || c.hashes[from.seq] !== from.hash) {
        throw new ApiError(409, 'history_diverged', 'Diverged');
      }
      const leaves = c.leaves.slice(from.seq, from.seq + pageSize);
      const last = from.seq + leaves.length;
      return {
        data: {
          head: c.head,
          leaves,
          ...(leaves.length === pageSize && last < c.head.seq ? { next: last } : {}),
        },
      };
    },
    verify: async () => ({ data: { ok: true, checkedAt: new Date().toISOString() } }),
    report: async (body) => {
      reports.push(body);
    },
    ...overrides,
  };
  return { api, reports };
}

const at = (c: Chain, seq: number): Witness => ({
  v: 1,
  seq,
  hash: c.hashes[seq]!,
  verifiedAt: '2026-10-01T12:00:00.000Z',
});

const opts = { subtle, now: () => new Date('2026-10-20T09:00:00.000Z') };
const check = (stored: Witness | null, api: WitnessApi) => checkWitness(stored, api, opts);
const reason = async (p: ReturnType<typeof check>) => {
  const o = await p;
  return o.state === 'failed' ? o.failure.reason : o.state;
};

/** A proof as a modified api would serve it from a rewritten chain: its leaves and its head. */
function rewritten(c: Chain): WitnessApi['proof'] {
  return async (from) => ({
    data: { head: c.head, leaves: c.leaves.slice(from?.seq ?? c.head.seq) },
  });
}

describe('checkWitness', () => {
  let c: Chain;
  beforeEach(async () => {
    c = await chain(Array.from({ length: 6 }, (_, i) => leaf(i + 1)));
  });

  it('trusts the head on a device’s first check', async () => {
    const o = await check(null, server(c).api);
    expect(o).toEqual({
      state: 'first',
      witness: { v: 1, ...c.head, verifiedAt: '2026-10-20T09:00:00.000Z' },
    });
  });

  it('accepts a chain that only grew, and one that stayed the same', async () => {
    const grown = await check(at(c, 3), server(c).api);
    expect(grown).toMatchObject({ state: 'verified', grew: 3, witness: { ...c.head } });
    expect(await check(at(c, 6), server(c).api)).toMatchObject({ state: 'verified', grew: 0 });
    // From genesis too: a household whose witness was set before anything happened.
    expect(await check(at(c, 0), server(c).api)).toMatchObject({ state: 'verified', grew: 6 });
  });

  it('follows a proof over several pages, folding from where each page ended', async () => {
    const proof = vi.fn(server(c, {}, 2).api.proof);
    const o = await check(at(c, 1), { ...server(c).api, proof });
    expect(o).toMatchObject({ state: 'verified', grew: 5 });
    expect(proof.mock.calls.map(([from]) => from?.seq)).toEqual([1, 3, 5]);
    expect(proof.mock.calls[1]![0]!.hash).toBe(c.hashes[3]);
  });

  describe('fails when the history was rewritten before the witness', () => {
    // An honest api answers 409; a modified one serves the rewritten chain's leaves and head.
    const cases: [string, (l: string[]) => string[]][] = [
      ['an entry edited', (l) => l.with(1, leaf(99))],
      ['an entry inserted', (l) => [...l.slice(0, 2), leaf(99), ...l.slice(2)]],
      ['an entry deleted', (l) => l.toSpliced(1, 1)],
      ['two entries reordered', (l) => [l[0]!, l[2]!, l[1]!, ...l.slice(3)]],
    ];
    it.each(cases)('%s', async (_, rewrite) => {
      const other = await chain([...rewrite(c.leaves.slice(0, 4)), leaf(7), leaf(8)]);
      expect(await reason(check(at(c, 4), server(other).api))).toBe('history_diverged');
      const modified = server(other, { proof: rewritten(other) }).api;
      expect(await reason(check(at(c, 4), modified))).toBe('fold_mismatch');
    });
  });

  it('fails when the tail was truncated', async () => {
    const short = await chain(c.leaves.slice(0, 3));
    expect(await reason(check(at(c, 5), server(short).api))).toBe('history_diverged');
    // A modified api answering 200 with the shorter head.
    const o = await check(at(c, 5), server(short, { proof: rewritten(short) }).api);
    expect(o).toMatchObject({
      state: 'failed',
      failure: { reason: 'seq_regressed', observed: short.head, lastVerified: at(c, 5) },
    });
  });

  it('fails on a forged proof', async () => {
    const proof = (data: unknown) => server(c, { proof: async () => ({ data }) }).api;
    const after = c.leaves.slice(3);
    // Wrong leaves, with the real head.
    expect(
      await reason(check(at(c, 3), proof({ head: c.head, leaves: [leaf(9), ...after.slice(1)] }))),
    ).toBe('fold_mismatch');
    // A skipped leaf: too few for the head's position, or a head moved back to match.
    expect(await reason(check(at(c, 3), proof({ head: c.head, leaves: after.slice(1) })))).toBe(
      'malformed_proof',
    );
    expect(
      await reason(
        check(at(c, 3), proof({ head: { ...c.head, seq: 5 }, leaves: after.toSpliced(1, 1) })),
      ),
    ).toBe('fold_mismatch');
    // A head that the leaves don't fold to.
    expect(
      await reason(check(at(c, 3), proof({ head: { ...c.head, hash: leaf(1) }, leaves: after }))),
    ).toBe('fold_mismatch');
    // A page that claims more follow, but doesn't line up with its leaves.
    expect(
      await reason(check(at(c, 3), proof({ head: c.head, leaves: after.slice(0, 1), next: 5 }))),
    ).toBe('malformed_proof');
  });

  it('fails when a later page doesn’t fold to the head', async () => {
    const honest = server(c, {}, 2).api;
    const proof: WitnessApi['proof'] = async (from) => {
      // A modified api, answering from the real chain whatever hash it's asked with.
      const body = (await honest.proof({ seq: from!.seq, hash: c.hashes[from!.seq]! })) as {
        data: { leaves: string[] };
      };
      if (from!.seq === 3) body.data.leaves = [leaf(42), body.data.leaves[1]!];
      return body;
    };
    expect(await reason(check(at(c, 1), { ...honest, proof }))).toBe('fold_mismatch');
  });

  it('fails on a range in the old format (409 proof_unavailable)', async () => {
    const api = server(c, {
      proof: async () => {
        throw new ApiError(409, 'proof_unavailable', 'Unavailable');
      },
    }).api;
    expect(await reason(check(at(c, 2), api))).toBe('proof_unavailable');
  });

  it('fails on a malformed proof', async () => {
    const bodies: unknown[] = [
      null,
      {},
      { data: null },
      { data: { leaves: [] } },
      { data: { head: { seq: 6 }, leaves: [] } },
      { data: { head: { seq: -1, hash: c.head.hash }, leaves: [] } },
      { data: { head: { seq: 1.5, hash: c.head.hash }, leaves: [] } },
      { data: { head: { seq: '6', hash: c.head.hash }, leaves: [] } },
      { data: { head: { seq: 6, hash: c.head.hash.toUpperCase() }, leaves: [] } },
      { data: { head: { seq: 6, hash: c.head.hash.slice(2) }, leaves: [] } },
      { data: { head: c.head } },
      { data: { head: c.head, leaves: 'abc' } },
      { data: { head: c.head, leaves: ['zz'.repeat(32)] } },
      { data: { head: c.head, leaves: [`${leaf(1)}00`] } },
      { data: { head: c.head, leaves: [], next: 'x' } },
    ];
    for (const body of bodies) {
      const api = server(c, { proof: async () => body }).api;
      expect(await reason(check(at(c, 6), api)), JSON.stringify(body)).toBe('malformed_proof');
    }
  });

  it('fails when the proof holds but the server’s own check doesn’t', async () => {
    const broken = server(c, { verify: async () => ({ data: { ok: false } }) }).api;
    expect(await reason(check(at(c, 3), broken))).toBe('verify_failed');
    const odd = server(c, { verify: async () => ({ data: {} }) }).api;
    expect(await reason(check(at(c, 3), odd))).toBe('malformed_proof');
  });

  it('couldn’t check on network trouble or a 5xx, which is not a failure', async () => {
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    const down = async () => {
      throw new ApiError(503, 'unavailable', 'Service unavailable');
    };
    for (const api of [
      server(c, { proof: offline }).api,
      server(c, { proof: down }).api,
      server(c, { verify: offline }).api,
      server(c, { verify: down }).api,
    ]) {
      expect(await check(at(c, 3), api)).toEqual({ state: 'unreachable', witness: at(c, 3) });
    }
    expect(await check(null, server(c, { proof: offline }).api)).toEqual({
      state: 'unreachable',
      witness: null,
    });
  });

  it('is unavailable without SubtleCrypto (not a secure context)', async () => {
    const insecure = await checkWitness(at(c, 3), server(c).api, {
      subtle: null as unknown as SubtleCrypto,
    });
    expect(insecure).toEqual({ state: 'unavailable', why: 'insecure' });
  });
});

describe('runHistoryCheck', () => {
  const HH = 'hh-1';
  let c: Chain;
  beforeEach(async () => {
    localStorage.clear();
    c = await chain(Array.from({ length: 4 }, (_, i) => leaf(i + 1)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores the head on the first check, and moves it forward as the chain grows', async () => {
    expect((await runHistoryCheck(HH, server(c).api, opts)).state).toBe('first');
    expect(storedWitness(HH)).toEqual({ v: 1, ...c.head, verifiedAt: '2026-10-20T09:00:00.000Z' });
    expect(JSON.parse(localStorage.getItem(witnessKey(HH))!)).toEqual(storedWitness(HH));

    const grown = await chain([...c.leaves, leaf(5)]);
    expect((await runHistoryCheck(HH, server(grown).api, opts)).state).toBe('verified');
    expect(storedWitness(HH)).toMatchObject(grown.head);
    // Couldn't check: the witness stays as it was.
    const offline = server(grown, {
      proof: async () => {
        throw new TypeError('Failed to fetch');
      },
    }).api;
    expect((await runHistoryCheck(HH, offline, opts)).state).toBe('unreachable');
    expect(storedWitness(HH)).toMatchObject(grown.head);
  });

  it('keeps the witness after a failure, and reports it once per stored head', async () => {
    localStorage.setItem(witnessKey(HH), JSON.stringify(at(c, 3)));
    const other = await chain([leaf(9), ...c.leaves.slice(1)]);
    const { api, reports } = server(other);
    const o = await runHistoryCheck(HH, api, opts);
    expect(o).toMatchObject({ state: 'failed', failure: { reason: 'history_diverged' } });
    expect(reports).toEqual([
      { lastVerified: { seq: 3, hash: c.hashes[3] }, observed: {}, reason: 'history_diverged' },
    ]);
    expect(storedFailure(HH)).toMatchObject({ reported: true, lastVerified: at(c, 3) });

    // Still failed on the next load, even if the server now answers as if nothing happened, and
    // not reported again.
    const later = await runHistoryCheck(HH, server(c).api, opts);
    expect(later).toMatchObject({ state: 'failed', failure: { reason: 'history_diverged' } });
    expect(reports).toHaveLength(1);
    expect(storedWitness(HH)).toEqual(at(c, 3));
  });

  it('warns even when the report doesn’t reach the server, and tries it again next load', async () => {
    localStorage.setItem(witnessKey(HH), JSON.stringify(at(c, 3)));
    const short = await chain(c.leaves.slice(0, 2));
    const report = vi.fn<WitnessApi['report']>().mockRejectedValueOnce(new TypeError('offline'));
    const api = server(short, { proof: rewritten(short), report }).api;
    const first = await runHistoryCheck(HH, api, opts);
    expect(first).toMatchObject({ state: 'failed', failure: { reason: 'seq_regressed' } });
    expect(first.state === 'failed' && first.failure.reported).toBeFalsy();
    expect(await runHistoryCheck(HH, api, opts)).toMatchObject({
      state: 'failed',
      failure: { reported: true },
    });
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]![0]).toMatchObject({ observed: short.head });
  });

  it('re-baselines only when a member accepts the current history, keeping the failure', async () => {
    localStorage.setItem(witnessKey(HH), JSON.stringify(at(c, 3)));
    const other = await chain([leaf(9), ...c.leaves]);
    await runHistoryCheck(HH, server(other).api, opts);
    const failure = storedFailure(HH)!;

    await acceptCurrentHistory(HH, server(other).api, opts.now);
    expect(storedWitness(HH)).toMatchObject(other.head);
    expect(storedFailure(HH)).toBeNull();
    expect(storedRebaselines(HH)).toEqual([
      { failure, acceptedAt: '2026-10-20T09:00:00.000Z', baseline: other.head },
    ]);
    expect((await runHistoryCheck(HH, server(other).api, opts)).state).toBe('verified');
  });

  it('is unavailable without storage, and never a false alarm', async () => {
    const blocked = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    const { api, reports } = server(c);
    expect(await runHistoryCheck(HH, api, opts)).toEqual({ state: 'unavailable', why: 'storage' });
    expect(reports).toEqual([]);
  });

  it('keeps households apart', async () => {
    await runHistoryCheck('a', server(c).api, opts);
    expect(storedWitness('a')).not.toBeNull();
    expect(storedWitness('b')).toBeNull();
  });
});
