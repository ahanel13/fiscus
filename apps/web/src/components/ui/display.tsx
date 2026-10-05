// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={clsx('rounded-xl border border-border bg-surface p-5', className)}>
      {children}
    </div>
  );
}

export function Alert({
  tone = 'error',
  children,
}: {
  tone?: 'error' | 'warning' | 'info' | 'success';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={clsx(
        'rounded-lg border px-3 py-2 text-sm',
        tone === 'error' && 'border-danger/40 bg-danger-soft text-danger',
        tone === 'warning' && 'border-warning/40 bg-warning-soft text-warning',
        tone === 'info' && 'border-border bg-surface-2',
        tone === 'success' && 'border-positive/40 bg-accent-soft text-positive',
      )}
    >
      {children}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';

/** A short status label. The words carry the meaning; color only reinforces it. */
export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tone === 'neutral' && 'bg-surface-2 text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent-text',
        tone === 'positive' && 'bg-accent-soft text-positive',
        tone === 'warning' && 'bg-warning-soft text-warning',
        tone === 'danger' && 'bg-danger-soft text-danger',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? [words[0]!, words.at(-1)!].map((w) => [...w][0])
      : [...(words[0] ?? '?')].slice(0, 1);
  return letters.join('').toLocaleUpperCase();
}

/**
 * A member's identity: their color with their initials (style guide §5: never color alone).
 * Decorative when the name is shown next to it; otherwise pass `label`.
 */
export function Avatar({
  name,
  color,
  size = 'md',
  label,
  className,
}: {
  name: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
  /** Accessible name when the avatar stands alone. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none',
        size === 'sm' && 'size-6 text-[11px]',
        size === 'md' && 'size-8 text-xs',
        size === 'lg' && 'size-10 text-sm',
        className,
      )}
      style={{ background: color }}
    >
      {initials(name)}
    </span>
  );
}

/** A placeholder while content loads. Screen readers hear `label` once, not each bar. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden className={clsx('block animate-pulse rounded-md bg-surface-2', className)} />
  );
}

export function LoadingRegion({
  label = 'Loading',
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-xs">
      {children}
    </kbd>
  );
}
