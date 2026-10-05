import { clsx } from 'clsx';
import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Checkbox as AriaCheckbox,
  type CheckboxProps as AriaCheckboxProps,
  composeRenderProps,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  type RadioGroupProps as AriaRadioGroupProps,
  type RadioProps,
  Switch as AriaSwitch,
  type SwitchProps as AriaSwitchProps,
  ToggleButton,
  ToggleButtonGroup,
  type ToggleButtonGroupProps,
  type Key,
} from 'react-aria-components';
import { Description, FieldError, type FieldProps, Label } from './field.js';
import { cx } from './utils.js';

const box =
  'flex size-5 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-surface text-accent-fg transition-colors ' +
  'group-selected:border-accent group-selected:bg-accent group-indeterminate:border-accent group-indeterminate:bg-accent ' +
  'group-invalid:border-danger group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent';

export function Checkbox({ className, children, ...props }: AriaCheckboxProps) {
  return (
    <AriaCheckbox
      {...props}
      className={cx(
        'group flex min-h-11 items-center gap-2.5 text-sm sm:min-h-8 disabled:opacity-60',
        className,
      )}
    >
      {composeRenderProps(children, (children, { isSelected, isIndeterminate }) => (
        <>
          <span className={box}>
            {isIndeterminate ? (
              <Minus aria-hidden className="size-3.5" strokeWidth={3} />
            ) : isSelected ? (
              <Check aria-hidden className="size-3.5" strokeWidth={3} />
            ) : null}
          </span>
          {children}
        </>
      ))}
    </AriaCheckbox>
  );
}

/** An on/off setting that takes effect immediately (no save button). */
export function Switch({ className, children, ...props }: AriaSwitchProps) {
  return (
    <AriaSwitch
      {...props}
      className={cx(
        'group flex min-h-11 items-center gap-3 text-sm sm:min-h-8 disabled:opacity-60',
        className,
      )}
    >
      {composeRenderProps(children, (children) => (
        <>
          <span
            className={
              'flex h-5 w-9 shrink-0 items-center rounded-full bg-border-strong p-0.5 transition-colors ' +
              'group-selected:bg-accent group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent'
            }
          >
            <span className="size-4 rounded-full bg-surface shadow-sm transition-transform group-selected:translate-x-4" />
          </span>
          {children}
        </>
      ))}
    </AriaSwitch>
  );
}

export function RadioGroup({
  label,
  description,
  errorMessage,
  className,
  children,
  ...props
}: AriaRadioGroupProps & FieldProps & { children: ReactNode }) {
  return (
    <AriaRadioGroup {...props} className={cx('flex flex-col gap-2', className)}>
      {label ? <Label>{label}</Label> : null}
      {children}
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </AriaRadioGroup>
  );
}

const dot =
  'flex size-5 shrink-0 items-center justify-center rounded-full border border-border-strong bg-surface ' +
  'group-selected:border-[6px] group-selected:border-accent group-invalid:border-danger ' +
  'group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent';

export function Radio({ className, children, ...props }: RadioProps) {
  return (
    <AriaRadio
      {...props}
      className={cx(
        'group flex min-h-11 items-center gap-2.5 text-sm sm:min-h-8 disabled:opacity-60',
        className,
      )}
    >
      {composeRenderProps(children, (children) => (
        <>
          <span className={dot} />
          {children}
        </>
      ))}
    </AriaRadio>
  );
}

/** A radio presented as a card, for choices that need a sentence of explanation. */
export function RadioCard({
  title,
  description,
  ...props
}: Omit<RadioProps, 'children'> & { title: string; description?: string }) {
  return (
    <AriaRadio
      {...props}
      className={
        'group flex cursor-default gap-3 rounded-lg border border-border p-3 transition-colors ' +
        'hover:bg-surface-2 selected:border-accent selected:bg-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
      }
    >
      <span className={clsx(dot, 'mt-0.5')} />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        {description ? <span className="block text-sm text-muted">{description}</span> : null}
      </span>
    </AriaRadio>
  );
}

/**
 * A compact single choice among 2–4 options (lens, theme, density). Announced as a radio group.
 * Always one option selected.
 */
export function SegmentedControl<K extends string>({
  options,
  value,
  onChange,
  className,
  ...props
}: Omit<ToggleButtonGroupProps, 'selectedKeys' | 'onSelectionChange' | 'selectionMode'> & {
  options: readonly { value: K; label: ReactNode }[];
  value: K;
  onChange: (value: K) => void;
}) {
  return (
    <ToggleButtonGroup
      {...props}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys: Set<Key>) => {
        const [next] = keys;
        if (next !== undefined) onChange(next as K);
      }}
      className={cx(
        'inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm',
        className as string | undefined,
      )}
    >
      {options.map((o) => (
        <ToggleButton
          key={o.value}
          id={o.value}
          className={
            'min-h-10 cursor-default rounded-md px-3 transition-colors sm:min-h-8 ' +
            'hover:bg-surface-2 selected:bg-accent selected:text-accent-fg'
          }
        >
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
