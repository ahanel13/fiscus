// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';

/**
 * The Fiscus mark: the front of the Temple of Saturn, which held Rome's treasury. The pediment
 * takes the accent and the rest the text color, so it follows the theme. The favicon
 * (public/favicon.svg) is the same drawing with three columns, which hold up at 16px.
 */
export function FiscusMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={clsx('shrink-0', className)}>
      <path d="M6 22 32 8l26 14Z" className="fill-accent" />
      <g fill="currentColor">
        <rect x="9" y="25" width="46" height="5" rx="1.5" />
        <rect x="13" y="33" width="6" height="16" rx="1" />
        <rect x="23.67" y="33" width="6" height="16" rx="1" />
        <rect x="34.33" y="33" width="6" height="16" rx="1" />
        <rect x="45" y="33" width="6" height="16" rx="1" />
        <rect x="7" y="52" width="50" height="5" rx="1.5" />
      </g>
    </svg>
  );
}

/** The mark beside the name, as on the sign-in pages. */
export function FiscusLogo({ className }: { className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <FiscusMark className="size-8" />
      <span className="text-xl font-extrabold tracking-tight">Fiscus</span>
    </span>
  );
}
