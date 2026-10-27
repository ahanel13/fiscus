// SPDX-License-Identifier: AGPL-3.0-or-later
import type { InstitutionSummary } from '@fiscus/shared';
import clsx from 'clsx';
import { useState } from 'react';
import { apiBase } from '../config.js';
import { initials } from './ui.js';

/** Black or white, whichever reads better on `#rrggbb` (WCAG relative luminance). */
export function textOn(color: string): '#000000' | '#ffffff' {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast with black is (l + 0.05) / 0.05, with white 1.05 / (l + 0.05): the larger wins.
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/**
 * A bank's logo (#423), from Fiscus's own origin, or its initials on the bank's color when it has
 * no logo, or on a neutral one for an account that isn't connected. Decorative: the bank's or
 * account's name is always beside it.
 */
export function BankLogo({
  institution,
  name,
  size = 'md',
}: {
  institution: InstitutionSummary | null | undefined;
  /** What the initials come from without a bank: the account's name. */
  name: string;
  size?: 'sm' | 'md';
}) {
  const [failed, setFailed] = useState(false);
  const box = size === 'sm' ? 'size-6 text-[0.625rem]' : 'size-8 text-xs';
  if (institution?.hasLogo && !failed) {
    return (
      <img
        src={`${apiBase()}/api/v1/institutions/${institution.id}/logo`}
        alt=""
        aria-hidden
        className={clsx(
          box,
          'shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-border',
        )}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={clsx(
        box,
        'grid shrink-0 place-items-center rounded-lg font-semibold',
        !institution?.color && 'bg-surface-2 text-muted',
      )}
      style={
        institution?.color
          ? { backgroundColor: institution.color, color: textOn(institution.color) }
          : undefined
      }
    >
      {initials(institution?.name ?? name)}
    </span>
  );
}
