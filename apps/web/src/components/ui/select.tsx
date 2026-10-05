import { clsx } from 'clsx';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Button as AriaButton,
  ComboBox as AriaComboBox,
  type ComboBoxProps as AriaComboBoxProps,
  Header,
  Input as AriaInput,
  ListBox,
  ListBoxItem,
  type ListBoxItemProps,
  ListBoxSection,
  Popover,
  Select as AriaSelect,
  type SelectProps as AriaSelectProps,
  SelectValue,
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
  };

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
  ...props
}: SelectProps<T>) {
  return (
    <AriaSelect {...props} className={cx('flex flex-col gap-1.5', className)}>
      {label ? <Label>{label}</Label> : null}
      <AriaButton
        className={clsx(controlStyles, 'flex items-center gap-2 text-left', triggerClassName)}
      >
        <SelectValue className="flex-1 truncate placeholder-shown:text-muted" />
        <ChevronDown aria-hidden className="size-4 text-muted" />
      </AriaButton>
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
      <Popover className={clsx(popoverStyles, 'min-w-(--trigger-width)')}>
        <ListBox items={items} className={listBoxStyles}>
          {children}
        </ListBox>
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
        <ListBox className={listBoxStyles}>{children}</ListBox>
      </Popover>
    </AriaComboBox>
  );
}
