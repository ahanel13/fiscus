import { createLink } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { forwardRef } from 'react';
import {
  Button as AriaButton,
  type ButtonProps as AriaButtonProps,
  composeRenderProps,
  Link as AriaLink,
  type LinkProps as AriaLinkProps,
} from 'react-aria-components';
import { cx } from './utils.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm' | 'icon';

interface StyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Shared by buttons and links that look like buttons. Touch targets are 44 px on phones. */
export function buttonStyles({ variant = 'primary', size = 'md' }: StyleProps = {}): string {
  return clsx(
    'inline-flex shrink-0 cursor-default items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-60 pending:cursor-wait',
    size === 'md' && 'min-h-11 px-3.5 sm:min-h-9',
    size === 'sm' && 'min-h-9 px-2.5 sm:min-h-8',
    size === 'icon' && 'size-11 sm:size-9',
    variant === 'primary' &&
      'bg-accent text-accent-fg hover:bg-accent-hover pressed:bg-accent-hover',
    variant === 'secondary' &&
      'border border-border-strong bg-surface text-fg hover:bg-surface-2 pressed:bg-surface-2',
    variant === 'ghost' && 'text-fg hover:bg-surface-2 pressed:bg-surface-2',
    variant === 'danger' &&
      'border border-danger/40 bg-surface text-danger hover:bg-danger-soft pressed:bg-danger-soft',
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent',
        className,
      )}
    />
  );
}

export type ButtonProps = AriaButtonProps & StyleProps;

/**
 * A button. Use `onPress` (not `onClick`): it handles mouse, touch, and keyboard the same way.
 * `isPending` shows a spinner and blocks repeat presses while keeping focus on the button.
 */
export function Button({ variant, size, className, children, ...props }: ButtonProps) {
  return (
    <AriaButton {...props} className={cx(buttonStyles({ variant, size }), className)}>
      {composeRenderProps(children, (children, { isPending }) => (
        <>
          {isPending ? <Spinner /> : null}
          {children}
        </>
      ))}
    </AriaButton>
  );
}

const StyledLink = forwardRef<HTMLAnchorElement, AriaLinkProps & StyleProps>(function StyledLink(
  { variant, size, className, ...props },
  ref,
) {
  return (
    <AriaLink ref={ref} {...props} className={cx(buttonStyles({ variant, size }), className)} />
  );
});

/** A router link that looks like a button (never nest a button inside a link). */
export const ButtonLink = createLink(StyledLink);
