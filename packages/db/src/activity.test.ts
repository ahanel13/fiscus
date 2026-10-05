import { describe, expect, it } from 'vitest';
import { canonical, entryHash } from './activity.js';

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
    const prev = Buffer.alloc(32);
    expect(
      entryHash(prev, base).equals(entryHash(prev, { ...base, metadata: { b: 2, a: 1 } })),
    ).toBe(true);
    expect(entryHash(prev, base).equals(entryHash(prev, { ...base, seq: 2 }))).toBe(false);
    expect(entryHash(prev, base).equals(entryHash(Buffer.alloc(32, 1), base))).toBe(false);
  });
});
