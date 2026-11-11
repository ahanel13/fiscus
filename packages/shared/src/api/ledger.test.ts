// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isEmoji, updateCategorySchema } from './ledger.js';

describe('category icons (#423)', () => {
  it('takes one emoji, with its variation, skin tone, flag or keycap', () => {
    for (const s of ['☕', '🍽️', '🅿️', '👍🏽', '👨‍👩‍👧', '🇺🇸', '1️⃣', '❔'])
      expect([s, isEmoji(s)]).toEqual([s, true]);
  });

  it('refuses text, two emoji, or nothing', () => {
    for (const s of ['', 'a', 'Coffee', '☕☕', '1', '#', '<img>'])
      expect([s, isEmoji(s)]).toEqual([s, false]);
  });

  it('lets a category have no icon', () => {
    expect(updateCategorySchema.parse({ icon: null })).toEqual({ icon: null });
    expect(updateCategorySchema.safeParse({ icon: 'x' }).success).toBe(false);
  });
});
