// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  type TabListProps,
  TabPanel as AriaTabPanel,
  type TabPanelProps,
  type TabProps,
  Tabs as AriaTabs,
  type TabsProps,
} from 'react-aria-components';
import { cx } from './utils.js';

/** Tabs switch between views of the same thing. Use links for navigating between pages. */
export function Tabs({ className, ...props }: TabsProps) {
  return <AriaTabs {...props} className={cx('flex flex-col gap-4', className)} />;
}

export function TabList<T extends object>({ className, ...props }: TabListProps<T>) {
  return (
    <AriaTabList
      {...props}
      className={cx('flex gap-1 overflow-x-auto border-b border-border', className)}
    />
  );
}

export function Tab({ className, ...props }: TabProps) {
  return (
    <AriaTab
      {...props}
      className={cx(
        '-mb-px flex min-h-11 cursor-default items-center border-b-2 border-transparent px-3 text-sm whitespace-nowrap text-muted outline-none transition-colors sm:min-h-9 ' +
          'hover:text-fg selected:border-accent selected:font-medium selected:text-fg disabled:opacity-50 ' +
          'focus-visible:rounded-t-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        className,
      )}
    />
  );
}

export function TabPanel({ className, ...props }: TabPanelProps) {
  return <AriaTabPanel {...props} className={cx('outline-none', className)} />;
}
