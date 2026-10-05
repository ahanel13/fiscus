import { clsx } from 'clsx';
import { composeRenderProps } from 'react-aria-components';

/** Merges our base classes with a React Aria `className`, which may be a function of its state. */
export function cx<T>(
  base: string,
  className:
    string | ((values: T & { defaultClassName: string | undefined }) => string) | undefined,
) {
  return composeRenderProps(className, (c) => clsx(base, c));
}

/** Text inputs, select triggers, and date fields share one look (style guide §7). */
export const controlStyles =
  'w-full min-h-11 rounded-md border border-border-strong bg-surface px-3 text-base text-fg sm:min-h-9 sm:text-sm ' +
  'placeholder:text-muted invalid:border-danger disabled:cursor-not-allowed disabled:opacity-60';

/** Overlays fade in and out (style guide §7: 150–200 ms, opacity only). */
export const fade =
  'transition-opacity duration-150 ease-standard entering:opacity-0 exiting:opacity-0';

/** Menus, listboxes, popovers. */
export const popoverStyles =
  'rounded-lg border border-border bg-surface text-fg shadow-md outline-none ' + fade;

export const labelStyles = 'text-sm font-medium';
