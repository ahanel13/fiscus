// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Transaction } from '@fiscus/shared';
import clsx from 'clsx';
import { useState } from 'react';
import { apiBase } from '../config.js';

/**
 * A merchant's logo (#423), from Fiscus's own origin, or the first letter of the transaction's
 * name on a neutral square, as Monarch shows them. Decorative: the name is always beside it.
 */
export function MerchantLogo({
  t,
  size = 'md',
}: {
  t: Pick<Transaction, 'merchantLogoId' | 'displayName'>;
  size?: 'sm' | 'md';
}) {
  const [failed, setFailed] = useState(false);
  const box = size === 'sm' ? 'size-6 text-[0.625rem]' : 'size-8 text-xs';
  if (t.merchantLogoId && !failed) {
    return (
      <img
        src={`${apiBase()}/api/v1/merchant-logos/${t.merchantLogoId}`}
        alt=""
        aria-hidden
        loading="lazy"
        className={clsx(box, 'shrink-0 rounded-full bg-white object-cover ring-1 ring-border')}
        onError={() => setFailed(true)}
      />
    );
  }
  const letter = [...t.displayName.trim()][0]?.toUpperCase() ?? '?';
  return (
    <span
      aria-hidden
      className={clsx(
        box,
        'grid shrink-0 place-items-center rounded-full bg-surface-2 font-semibold text-muted',
      )}
    >
      {letter}
    </span>
  );
}
