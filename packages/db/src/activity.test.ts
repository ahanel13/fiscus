// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { canonical, entryHash, foldLeaves, GENESIS_HASH, leafHash, linkHash } from './activity.js';

const base = {
  scopeId: 's',
  seq: 1,
  occurredAt: new Date(0),
  actorKind: 'user' as const,
  actorUserId: null,
  actorMemberId: null,
  householdId: 's',
  action: 'x',
  targetType: null,
  targetId: null,
  visibleToHousehold: true,
  metadata: { a: 1, b: 2 },
  ip: null,
  changesEnc: null,
};

describe('canonical form', () => {
  it('sorts keys at every level and normalizes values', () => {
    expect(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(
      canonical({
        when: new Date('2026-10-05T12:00:00Z'),
        bytes: Buffer.from('hi'),
        gone: undefined,
      }),
    ).toBe('{"bytes":"aGk=","when":"2026-10-05T12:00:00.000Z"}');
  });

  it('gives the same hash for the same entry regardless of key order', () => {
    const prev = Buffer.alloc(32);
    expect(
      entryHash(prev, base).equals(entryHash(prev, { ...base, metadata: { b: 2, a: 1 } })),
    ).toBe(true);
    expect(entryHash(prev, base).equals(entryHash(prev, { ...base, seq: 2 }))).toBe(false);
    expect(entryHash(prev, base).equals(entryHash(Buffer.alloc(32, 1), base))).toBe(false);
  });
});

/**
 * Fixed vectors for chain format version 2 (#264). The browser's proof check folds leaves with
 * crypto.subtle and must reach the same hashes: change these only with a new hash version.
 */
describe('version 2 hashes', () => {
  const L1 = '11'.repeat(32);
  const L2 = '22'.repeat(32);
  const H1 = '8878b15a7d6a3a4f464e8f9f42591dbc0cf4bedea0ec309003d2b2ee53655ef8';
  const H2 = '78830000e1197790a7e1884139a65721210d642ad112e6c9899a05cb214027a5';

  it('hashes the canonical entry, with its version, as the leaf', () => {
    // SHA-256 of {"action":"x",…,"hashVersion":2,…,"visibleToHousehold":true}
    expect(leafHash(base).toString('hex')).toBe(
      '5ec83b8d818743ff6eb3d32fafc5a5bc19e4f677992c0d28af28176e16420293',
    );
    expect(leafHash({ ...base, metadata: { b: 2, a: 1 } }).equals(leafHash(base))).toBe(true);
    expect(leafHash({ ...base, action: 'y' }).equals(leafHash(base))).toBe(false);
  });

  it('links SHA-256(previous ‖ leaf), from the all-zero genesis', () => {
    expect(GENESIS_HASH).toBe('00'.repeat(32));
    const link = linkHash(Buffer.alloc(32), Buffer.from(L1, 'hex'));
    expect(link.toString('hex')).toBe(H1);
    // Not the same as version 1, which hashes the whole entry into the link.
    expect(
      linkHash(Buffer.alloc(32), leafHash(base)).equals(entryHash(Buffer.alloc(32), base)),
    ).toBe(false);
  });

  it('folds leaves from a known hash to the head', () => {
    expect(foldLeaves(GENESIS_HASH, [])).toBe(GENESIS_HASH);
    expect(foldLeaves(GENESIS_HASH, [L1])).toBe(H1);
    expect(foldLeaves(GENESIS_HASH, [L1, L2])).toBe(H2);
    // Folding in pages is the same as folding at once.
    expect(foldLeaves(foldLeaves(GENESIS_HASH, [L1]), [L2])).toBe(H2);
    // Order, a skipped leaf, and the starting point all matter.
    expect(foldLeaves(GENESIS_HASH, [L2, L1])).not.toBe(H2);
    expect(foldLeaves(GENESIS_HASH, [L2])).not.toBe(H2);
    expect(foldLeaves(H1, [L1, L2])).not.toBe(H2);
  });

  it('refuses anything but 32-byte lowercase hex', () => {
    expect(() => foldLeaves('00', [])).toThrow();
    expect(() => foldLeaves(GENESIS_HASH, ['zz'.repeat(32)])).toThrow();
    expect(() => foldLeaves(GENESIS_HASH, ['AB'.repeat(32)])).toThrow();
    expect(() => foldLeaves(GENESIS_HASH, [`${L1}00`])).toThrow();
  });
});
