// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { MenuItem, MenuSection } from './overlays.js';
import { optionCount } from './search-box.js';
import { SelectItem, SelectSection } from './select.js';

describe('optionCount', () => {
  const options = new Set<unknown>([SelectItem, MenuItem]);

  it('counts options through sections, fragments and arrays, not what is inside them', () => {
    const children = (
      <>
        <SelectSection title="Food">
          {['Groceries', 'Restaurants'].map((n) => (
            <SelectItem key={n} id={n}>
              {n}
            </SelectItem>
          ))}
        </SelectSection>
        <MenuSection>
          <MenuItem>
            <span>Travel</span>
            <span>Non-monthly</span>
          </MenuItem>
        </MenuSection>
      </>
    );
    expect(optionCount(undefined, children, options)).toBe(3);
  });

  it('counts items when given them', () => {
    expect(optionCount([1, 2, 3, 4], () => null, options)).toBe(4);
  });
});
