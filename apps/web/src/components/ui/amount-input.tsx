// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';
import { useState } from 'react';
import {
  Group,
  Input as AriaInput,
  NumberField,
  type NumberFieldProps,
} from 'react-aria-components';
import { minorUnitExponent } from '@fiscus/shared';
import { maxMajor, toMajor, toMinor } from '../../lib/amount.js';
import { Description, FieldError, type FieldProps, Label } from './field.js';
import { controlStyles, cx } from './utils.js';

export type AmountInputProps = Omit<
  NumberFieldProps,
  'value' | 'defaultValue' | 'onChange' | 'formatOptions' | 'minValue' | 'maxValue' | 'name'
> &
  FieldProps & {
    /** ISO 4217 code; decides the decimals (JPY 0, USD 2, KWD 3). */
    currency: string;
    /** Integer minor units (cents), or null when empty. */
    value?: number | null;
    defaultValue?: number | null;
    onChange?: (minor: number | null) => void;
    /** Submitted with forms as integer minor units. */
    name?: string;
    /** Allow amounts below zero (refunds, adjustments). Off by default. */
    allowNegative?: boolean;
    placeholder?: string;
  };

/**
 * Money entry. People type in their own format ("1,234.56", "1.234,56", "¥1,235"); the value in and
 * out is always integer minor units, never a float.
 */
export function AmountInput({
  label,
  description,
  errorMessage,
  currency,
  value,
  defaultValue = null,
  onChange,
  name,
  allowNegative,
  placeholder,
  className,
  ...props
}: AmountInputProps) {
  const [uncontrolled, setUncontrolled] = useState<number | null>(defaultValue);
  const minor = value !== undefined ? value : uncontrolled;
  const exponent = minorUnitExponent(currency);
  const max = maxMajor(currency);

  return (
    <NumberField
      {...props}
      value={minor === null ? Number.NaN : toMajor(minor, currency)}
      onChange={(major) => {
        const next = Number.isNaN(major) ? null : toMinor(major, currency);
        setUncontrolled(next);
        onChange?.(next);
      }}
      minValue={allowNegative ? -max : 0}
      maxValue={max}
      formatOptions={{
        style: 'currency',
        currency,
        minimumFractionDigits: exponent,
        maximumFractionDigits: exponent,
      }}
      className={cx('flex flex-col gap-1.5', className)}
    >
      {label ? <Label>{label}</Label> : null}
      <Group className="flex">
        <AriaInput placeholder={placeholder} className={clsx(controlStyles, 'amount text-right')} />
      </Group>
      {name ? <input type="hidden" name={name} value={minor ?? ''} /> : null}
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </NumberField>
  );
}
