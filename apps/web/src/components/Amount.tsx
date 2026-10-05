import { formatMoney } from '@fiscus/shared';
import { clsx } from 'clsx';

export type AmountKind = 'flow' | 'balance';

/**
 * Money on screen (style guide §4):
 * - flows: money in is green with "+", money out is plain text with "−" (spending isn't an error);
 * - balances: plain, except a negative balance (overdraft, overspent budget) is red;
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
  const inflow = kind === 'flow' && minor > 0;
  const negativeBalance = kind === 'balance' && minor < 0;
  const text = formatMoney(minor, currency, {
    signDisplay: kind === 'flow' ? 'exceptZero' : 'auto',
  }).replace('-', '−');
  const label =
    kind === 'flow' && minor !== 0
      ? `${inflow ? 'Received' : 'Spent'} ${formatMoney(Math.abs(minor), currency)}`
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
