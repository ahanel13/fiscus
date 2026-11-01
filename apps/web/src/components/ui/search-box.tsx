// SPDX-License-Identifier: AGPL-3.0-or-later
import { Search } from 'lucide-react';
import { Children, isValidElement, type ReactNode } from 'react';
import { Input, SearchField } from 'react-aria-components';

/** More options than this, and a list or menu opens with a search box to narrow it. */
export const SEARCH_FROM = 8;

/**
 * How many options a list or menu has: its `items`, or its `option` elements, found through
 * sections, fragments and arrays. A render function child counts as its `items`.
 */
export function optionCount(
  items: Iterable<unknown> | undefined,
  children: unknown,
  option: ReadonlySet<unknown>,
) {
  if (items) return [...items].length;
  let n = 0;
  const walk = (nodes: ReactNode) =>
    Children.forEach(nodes, (node) => {
      if (!isValidElement(node)) return;
      if (option.has(node.type)) n += 1;
      else walk((node.props as { children?: ReactNode }).children);
    });
  if (typeof children !== 'function') walk(children as ReactNode);
  return n;
}

/**
 * The search box at the top of an open list or menu, inside an `Autocomplete`. Opening puts the
 * cursor in it; arrows still move through the options, and Enter with none focused picks the
 * first match.
 */
export function SearchBox({ option }: { option: 'option' | 'menuitem' }) {
  return (
    <SearchField
      aria-label="Search"
      autoFocus
      className="border-b border-border p-1"
      onSubmit={() => {
        const input = document.activeElement;
        if (input?.getAttribute('aria-activedescendant')) return;
        const id = input?.getAttribute('aria-controls');
        const first = id
          ? document
              .getElementById(id)
              ?.querySelector<HTMLElement>(`[role=${option}]:not([aria-disabled=true])`)
          : null;
        first?.click();
      }}
    >
      <div className="flex items-center gap-2 px-2">
        <Search aria-hidden className="size-4 shrink-0 text-muted" />
        <Input
          placeholder="Type to search"
          className="min-h-9 w-full bg-transparent text-sm outline-none! placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
    </SearchField>
  );
}
