// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { rangeOf } from './range-select.js';

describe('rangeOf', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('covers the rows from the last one clicked to this one, either way', () => {
    expect(rangeOf(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeOf(order, 'e', 'c')).toEqual(['c', 'd', 'e']);
  });

  it('is just this row without an anchor still shown', () => {
    expect(rangeOf(order, null, 'c')).toEqual(['c']);
    expect(rangeOf(order, 'gone', 'c')).toEqual(['c']);
  });
});
