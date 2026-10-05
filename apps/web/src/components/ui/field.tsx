import type { ReactNode } from 'react';
import {
  FieldError as AriaFieldError,
  type FieldErrorProps,
  Form as AriaForm,
  type FormProps,
  Input as AriaInput,
  type InputProps,
  Label as AriaLabel,
  type LabelProps,
  Text,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
  type ValidationResult,
} from 'react-aria-components';
import { controlStyles, cx, labelStyles } from './utils.js';
import { clsx } from 'clsx';

/**
 * A form. Server validation errors go in `validationErrors` (keyed by field `name`, see
 * `ApiError.fieldErrors()`); each one clears as soon as the person edits that field.
 */
export function Form({ className, ...props }: FormProps) {
  return <AriaForm {...props} className={clsx('space-y-4', className)} />;
}

export function Label({ className, ...props }: LabelProps) {
  return <AriaLabel {...props} className={clsx(labelStyles, className)} />;
}

export function Description({ children }: { children: ReactNode }) {
  return (
    <Text slot="description" className="text-sm text-muted">
      {children}
    </Text>
  );
}

export function FieldError({ className, ...props }: FieldErrorProps) {
  return <AriaFieldError {...props} className={cx('text-sm text-danger', className)} />;
}

export function Input({ className, ...props }: InputProps) {
  return <AriaInput {...props} className={cx(controlStyles, className)} />;
}

export interface FieldProps {
  label?: string;
  description?: ReactNode;
  /** Shown when the field is invalid; defaults to the browser's or the server's message. */
  errorMessage?: string | ((v: ValidationResult) => string);
}

export type TextFieldProps = AriaTextFieldProps &
  FieldProps & { placeholder?: string; inputClassName?: string };

/** A labelled text input with an optional description and inline validation. */
export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  inputClassName,
  className,
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField {...props} className={cx('flex flex-col gap-1.5', className)}>
      {label ? <Label>{label}</Label> : null}
      <Input placeholder={placeholder} className={inputClassName} />
      {description ? <Description>{description}</Description> : null}
      <FieldError>{errorMessage}</FieldError>
    </AriaTextField>
  );
}
