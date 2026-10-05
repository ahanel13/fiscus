// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';
import { ArrowUp } from 'lucide-react';
import {
  Cell as AriaCell,
  type CellProps,
  Collection,
  Column as AriaColumn,
  type ColumnProps,
  composeRenderProps,
  Row as AriaRow,
  type RowProps,
  Table as AriaTable,
  TableBody as AriaTableBody,
  type TableBodyProps,
  TableHeader as AriaTableHeader,
  type TableHeaderProps,
  type TableProps,
  useTableOptions,
} from 'react-aria-components';
import { Checkbox } from './toggles.js';
import { cx } from './utils.js';

// Rows and cells follow the density setting (style guide §8): --row-h and --cell-px.

/** A data table with keyboard navigation, optional sorting and row selection. Needs `aria-label`. */
export function Table({ className, ...props }: TableProps) {
  return <AriaTable {...props} className={cx('w-full border-collapse text-sm', className)} />;
}

export function TableHeader<T extends object>({
  columns,
  children,
  ...props
}: TableHeaderProps<T>) {
  const { selectionBehavior, selectionMode, allowsDragging } = useTableOptions();
  return (
    <AriaTableHeader {...props} className="border-b border-border text-xs text-muted">
      {allowsDragging ? <AriaColumn /> : null}
      {selectionBehavior === 'toggle' ? (
        <AriaColumn className="w-10" style={{ paddingInline: 'var(--cell-px)' }}>
          {selectionMode === 'multiple' ? (
            <Checkbox slot="selection" aria-label="Select all" />
          ) : null}
        </AriaColumn>
      ) : null}
      <Collection items={columns}>{children}</Collection>
    </AriaTableHeader>
  );
}

/** Numbers are right-aligned (`align="end"`). */
export function Column({
  className,
  align = 'start',
  children,
  ...props
}: ColumnProps & { align?: 'start' | 'end' }) {
  return (
    <AriaColumn
      {...props}
      style={{ paddingInline: 'var(--cell-px)' }}
      className={cx(
        clsx(
          'h-9 font-medium outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          align === 'end' ? 'text-right' : 'text-left',
        ),
        className,
      )}
    >
      {composeRenderProps(children, (children, { allowsSorting, sortDirection }) => (
        <span
          className={clsx('inline-flex items-center gap-1', align === 'end' && 'flex-row-reverse')}
        >
          {children}
          {allowsSorting ? (
            <ArrowUp
              aria-hidden
              className={clsx(
                'size-3.5 transition-transform',
                !sortDirection && 'opacity-0',
                sortDirection === 'descending' && 'rotate-180',
              )}
            />
          ) : null}
        </span>
      ))}
    </AriaColumn>
  );
}

export function TableBody<T extends object>(props: TableBodyProps<T>) {
  return <AriaTableBody {...props} className="divide-y divide-border" />;
}

export function Row<T extends object>({ id, columns, children, className, ...props }: RowProps<T>) {
  const { selectionBehavior } = useTableOptions();
  return (
    <AriaRow
      id={id}
      {...props}
      style={{ height: 'var(--row-h)' }}
      className={cx(
        'outline-none hover:bg-surface-2 selected:bg-accent-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        className,
      )}
    >
      {selectionBehavior === 'toggle' ? (
        <AriaCell style={{ paddingInline: 'var(--cell-px)' }}>
          <Checkbox slot="selection" />
        </AriaCell>
      ) : null}
      <Collection items={columns}>{children}</Collection>
    </AriaRow>
  );
}

export function Cell({
  className,
  align = 'start',
  ...props
}: CellProps & { align?: 'start' | 'end' }) {
  return (
    <AriaCell
      {...props}
      style={{ paddingInline: 'var(--cell-px)' }}
      className={cx(
        clsx(
          'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
          align === 'end' && 'text-right',
        ),
        className,
      )}
    />
  );
}
