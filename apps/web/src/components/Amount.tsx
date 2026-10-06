// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatMoney } from '@fiscus/shared';
import { clsx } from 'clsx';
import { useLocale } from 'react-aria-components';

export type AmountKind = 'flow' | 'balance' | 'liability';

/**
 * Money on screen (style guide §4):
 * - flows: money in is green with "+", money out is plain text with "−" (spending isn't an error);
 * - balances: plain, except a negative balance (overdraft, overspent budget) is red;
 * - liabilities (credit cards, loans): plain with their sign. Owing on a mortgage isn't a problem;
 * - in the viewer's language ("1.234,56 €" in German);
 * - never color alone: the sign and an accessible label carry the meaning too.
 */
export function Amount({
  minor,
  currency,
  kind = 'flow',
  className,
}: {
  minor: number;
  currency: string;
  kind?: AmountKind;
  className?: string;
}) {
  const { locale } = useLocale();
  const inflow = kind === 'flow' && minor > 0;
  const negativeBalance = kind === 'balance' && minor < 0;
  const text = formatMoney(minor, currency, {
    locale,
    signDisplay: kind === 'flow' ? 'exceptZero' : 'auto',
  }).replace('-', '−');
  const label =
    kind === 'flow' && minor !== 0
      ? `${inflow ? 'Received' : 'Spent'} ${formatMoney(Math.abs(minor), currency, { locale })}`
      : undefined;
  return (
    <span
      className={clsx(
        'amount whitespace-nowrap',
        inflow && 'text-positive',
        negativeBalance && 'text-danger',
        className,
      )}
      aria-label={label}
    >
      {text}
    </span>
  );
}
