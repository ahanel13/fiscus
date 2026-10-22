// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Autocomplete,
  Button as AriaButton,
  ComboBox as AriaComboBox,
  type ComboBoxProps as AriaComboBoxProps,
  Header,
  Input as AriaInput,
  ListBox,
  ListBoxItem,
  type ListBoxItemProps,
  ListBoxSection,
  Input as SearchInput,
  Popover,
  SearchField,
  Select as AriaSelect,
  type SelectProps as AriaSelectProps,
  SelectValue,
  useFilter,
} from 'react-aria-components';
import { Description, FieldError, type FieldProps, Label } from './field.js';
import { controlStyles, cx, popoverStyles } from './utils.js';

const listBoxStyles = 'max-h-72 overflow-auto p-1 outline-none';

/** An option in a select, combo box, or list box. Shows a check when selected. */
export function SelectItem({ className, children, ...props }: ListBoxItemProps) {
  const textValue = props.textValue ?? (typeof children === 'string' ? children : undefined);
  return (
    <ListBoxItem
      {...props}
      textValue={textValue}
      className={cx(
        'flex min-h-11 cursor-default items-center gap-2 rounded-md px-2.5 text-sm outline-none sm:min-h-8 ' +
          'focus:bg-surface-2 selected:font-medium disabled:opacity-50',
        className,
      )}
    >
      {(values) => (
        <>
          <span className="flex-1 truncate">
            {typeof children === 'function' ? children(values) : children}
          </span>
          {values.isSelected ? <Check aria-hidden className="size-4 text-accent-text" /> : null}
        </>
      )}
    </ListBoxItem>
  );
}

/** A labelled group of options. */
export function SelectSection<T extends object>({
  title,
  children,
}: {
  title: string;
  children: ReactNode | ((item: T) => ReactNode);
}) {
  return (
    <ListBoxSection className="not-first:mt-1 not-first:border-t not-first:border-border not-first:pt-1">
      <Header className="px-2.5 py-1 text-xs font-semibold text-muted">{title}</Header>
      {children as ReactNode}
    </ListBoxSection>
  );
}

export type SelectProps<T extends object> = Omit<AriaSelectProps<T>, 'children'> &
  FieldProps & {
    items?: Iterable<T>;
    children: ReactNode | ((item: T) => ReactNode);
    triggerClassName?: string;
    /** `chip`: a small pill that fits inside a list row (a transaction's category). */
    appearance?: 'field' | 'chip';
    /** A search box at the top of the open list: type to narrow it (long lists, categories). */
    searchable?: boolean;
  };

const chipStyles =
  'inline-flex max-w-full min-h-7 items-center gap-1 rounded-full border border-transparent bg-surface-2 px-2.5 ' +
  'text-xs text-fg outline-none hover:border-border-strong pressed:border-border-strong ' +
  'focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60';

/**
 * Choose one option from a short list. Works in forms (`name`) and controlled
 * (`value` / `onChange`). For long lists people would rather search, use `ComboBox`.
 */
export function Select<T extends object>({
  label,
  description,
  errorMessage,
  items,
  children,
  className,
  triggerClassName,
  appearance = 'field',
  searchable,
  ...props
}: SelectProps<T>) {
  const chip = appearance === 'chip';
  const { contains } = useFilter({ sensitivity: 'base' });
  const list = (
    <ListBox
      items={items}
      className={listBoxStyles}
      // Searchable: nothing is focused until you type, so the search's first match gets focus
      // (focusing the selected option first left it pointing at an option the search had hidden).
      {...(searchable ? { autoFocus: false } : {})}
    >
      {children}
    </ListBox>
  );
  return (
    <AriaSelect
      {...props}
      className={cx(chip ? 'inline-flex min-w-0' : 'flex flex-col gap-1.5', className)}
    >
      {label ? <Label>{label}</Label> : null}
      <AriaButton
        className={clsx(
          chip ? chipStyles : [controlStyles, 'flex items-center gap-2 text-left'],
          triggerClassName,
        )}
      >
        <SelectValue className="min-w-0 flex-1 truncate placeholder-shown:text-muted" />
        <ChevronDown aria-hidden className={chip ? 'size-3 text-muted' : 'size-4 text-muted'} />
      </AriaButton>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={clsx(popoverStyles, 'min-w-(--trigger-width)')}>
        {searchable ? (
          // Opening it puts the cursor in the search box; arrows still move through the list.
          <Autocomplete filter={contains}>
            <SearchField
              aria-label="Search"
              autoFocus
              className="border-b border-border p-1"
              // Enter with no option focused yet picks the first match.
              onSubmit={() => {
                const input = document.activeElement;
                if (input?.getAttribute('aria-activedescendant')) return;
                const id = input?.getAttribute('aria-controls');
                const first = id
                  ? document
                      .getElementById(id)
                      ?.querySelector<HTMLElement>('[role=option]:not([aria-disabled=true])')
                  : null;
                first?.click();
              }}
            >
              <div className="flex items-center gap-2 px-2">
                <Search aria-hidden className="size-4 shrink-0 text-muted" />
                <SearchInput
                  placeholder="Type to search"
                  className="min-h-9 w-full bg-transparent text-sm outline-none! placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
                />
              </div>
            </SearchField>
            {list}
          </Autocomplete>
        ) : (
          list
        )}
      </Popover>
    </AriaSelect>
  );
}

export type ComboBoxProps<T extends object> = Omit<AriaComboBoxProps<T>, 'children'> &
  FieldProps & {
    placeholder?: string;
    children: ReactNode | ((item: T) => ReactNode);
  };

/** A searchable select, for long lists (time zones, currencies, categories). */
export function ComboBox<T extends object>({
  label,
  description,
  errorMessage,
  placeholder,
  items,
  children,
  className,
  ...props
}: ComboBoxProps<T>) {
  return (
    <AriaComboBox {...props} items={items} className={cx('flex flex-col gap-1.5', className)}>
      {label ? <Label>{label}</Label> : null}
      <div className="relative">
        <AriaInput placeholder={placeholder} className={clsx(controlStyles, 'pr-10')} />
        <AriaButton className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted">
          <ChevronDown aria-hidden className="size-4" />
        </AriaButton>
      </div>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={clsx(popoverStyles, 'min-w-(--trigger-width)')}>
        {/* Named like the field, also when it has only an aria-label (no visible label). */}
        <ListBox
          className={listBoxStyles}
          {...(props['aria-label'] && !label ? { 'aria-label': props['aria-label'] } : {})}
        >
          {children}
        </ListBox>
      </Popover>
    </AriaComboBox>
  );
}
