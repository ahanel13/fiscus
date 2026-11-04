// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SeriesChanges } from '@fiscus/shared';
import { Amount } from './Amount.js';
import { Badge } from './ui.js';

const month = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });

/**
 * A series' changes worth noticing, as badges (D14): "Up $5.00 since June", "New", "Looks
 * ended".
 */
export function ChangeBadges({
  changes,
  currency,
}: {
  changes: SeriesChanges | undefined;
  currency: string;
}) {
  if (!changes) return null;
  return (
    <>
      {changes.priceUp ? (
        <Badge tone="warning">
          Up <Amount minor={changes.priceUp.changeMinor} currency={currency} kind="balance" /> since{' '}
          {month(changes.priceUp.since)}
        </Badge>
      ) : null}
      {changes.isNew ? <Badge tone="accent">New</Badge> : null}
      {changes.looksEnded ? <Badge>Looks ended</Badge> : null}
    </>
  );
}
