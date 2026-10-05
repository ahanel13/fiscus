// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';
import { sourceUrl } from '../config.js';

const link = 'font-medium text-accent-text underline-offset-2 hover:underline';

/**
 * AGPL-3.0 §13: everyone using Fiscus over the network is offered its source. Shown on the
 * sign-in pages and in Personal settings.
 */
export function SourceLinks({
  className,
  size = 'xs',
}: {
  className?: string;
  size?: 'xs' | 'sm';
}) {
  return (
    <p className={clsx('text-muted', size === 'xs' ? 'text-xs' : 'text-sm', className)}>
      Fiscus is free software under the{' '}
      <a
        className={link}
        href="https://www.gnu.org/licenses/agpl-3.0.html"
        target="_blank"
        rel="noreferrer"
      >
        AGPL-3.0
      </a>
      .{' '}
      <a className={link} href={sourceUrl()} target="_blank" rel="noreferrer">
        Source code
      </a>{' '}
      ·{' '}
      <a className={link} href="/third-party-licenses.txt" target="_blank" rel="noreferrer">
        Third-party licenses
      </a>
    </p>
  );
}
