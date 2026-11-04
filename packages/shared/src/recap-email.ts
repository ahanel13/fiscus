// SPDX-License-Identifier: AGPL-3.0-or-later
import type { RecapComingUp, RecapDetail, RecapWorthALook, WeeklyRecap } from './api/recap.js';
import { formatMoney } from './money.js';

// The weekly recap as an email (#128; bills walkthrough §8, prototype 07-weekly-recap.html):
// subject, plain text and HTML, from a recap that's already only what its reader can see. Pure:
// sending it is the notification pipeline's (#125, #130). The detail level follows ADR 0014 §5.

export interface RecapEmail {
  subject: string;
  text: string;
  html: string;
}

export interface RecapEmailOptions {
  /** Full (default), summary (amounts, no names), or minimal (nothing about money). */
  detail?: RecapDetail;
  /** Where "Open Fiscus" goes. */
  url?: string;
}

const day = (d: string, o: Intl.DateTimeFormatOptions) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' });

/** "Nov 2–8", or "Oct 26–Nov 1" across months. */
export function weekLabel(start: string, end: string): string {
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return `${day(start, { month: 'short', day: 'numeric' })}–${
    sameMonth ? day(end, { day: 'numeric' }) : day(end, { month: 'short', day: 'numeric' })
  }`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function lines(r: WeeklyRecap, detail: RecapDetail) {
  const money = (m: number, o: { whole?: boolean; sign?: boolean } = {}) =>
    formatMoney(m, r.currency, {
      whole: o.whole ?? false,
      signDisplay: o.sign ? 'exceptZero' : 'auto',
    });
  const sees =
    r.sees === 'yours_and_ours'
      ? ' · what you can see: yours and ours.'
      : r.sees === 'yours'
        ? ' · what you can see: yours.'
        : '.';
  const header = {
    title: `Your week, ${weekLabel(r.weekStart, r.weekEnd)}`,
    sub: `${r.householdName}${sees}`,
  };
  if (detail === 'minimal') {
    return { header, figures: [], comingUp: [], worth: [], quiet: null, review: null, money };
  }
  const usual = r.spending.usualMinor;
  const diff = usual === null ? 0 : r.spending.spentMinor - usual;
  const figures = [
    {
      label: 'Spent',
      value: money(r.spending.spentMinor),
      note:
        usual === null || Math.abs(diff) < 100
          ? usual === null
            ? null
            : 'about as usual'
          : `${money(Math.abs(diff), { whole: true })} ${diff < 0 ? 'less' : 'more'} than usual`,
    },
    ...(r.budgets
      ? [
          {
            label: `Left in ${day(`${r.budgets.month}-01`, { month: 'long' })}’s budgets`,
            value: money(r.budgets.leftMinor),
            note: `${plural(r.budgets.daysLeft, 'day')} to go`,
          },
        ]
      : []),
    ...(r.netWorth
      ? [
          {
            label: 'Net worth',
            value: money(r.netWorth.netWorthMinor, { whole: true }),
            note:
              r.netWorth.changeMinor === 0
                ? 'no change this week'
                : `${money(r.netWorth.changeMinor, { whole: true, sign: true })} this week`,
          },
        ]
      : []),
  ];
  const comingUp = r.comingUp.map((c: RecapComingUp) => ({
    when: `${day(c.due, { weekday: 'short' })} ${Number(c.due.slice(8))}`,
    what:
      detail === 'full'
        ? `${c.name}${c.lookAfter ? ` · ${c.lookAfter} looks after it` : ''}`
        : c.kind === 'income'
          ? 'Money in'
          : c.kind === 'statement'
            ? 'A card statement'
            : 'A bill',
    amount:
      c.amountMinor === null
        ? ''
        : `${c.about ? 'about ' : ''}${c.amountMinor > 0 ? '+' : ''}${money(Math.abs(c.amountMinor))}`,
  }));
  const worth =
    detail === 'full'
      ? r.worthALook.map((w: RecapWorthALook) =>
          w.kind === 'over_budget'
            ? `${w.category} is ${money(w.overMinor)} over its budget`
            : w.kind === 'biggest_purchase'
              ? `${w.name}, ${money(Math.abs(w.amountMinor))}${w.account ? ` on ${w.account}` : ''} · your biggest this week`
              : `${w.name} is late: it was due ${day(w.due, { month: 'short', day: 'numeric' })}`,
        )
      : r.worthALook.length
        ? [summaryOfWorth(r.worthALook)]
        : [];
  return {
    header,
    figures,
    comingUp,
    worth,
    quiet: r.quiet ? 'A quiet week: nothing spent, and nothing coming up.' : null,
    review: r.toReview
      ? `${plural(r.toReview, 'transaction')} ${r.toReview === 1 ? 'is' : 'are'} waiting for review.`
      : null,
    money,
  };
}

function summaryOfWorth(items: RecapWorthALook[]): string {
  const over = items.filter((w) => w.kind === 'over_budget').length;
  const late = items.filter((w) => w.kind === 'late').length;
  const parts = [
    over ? `${plural(over, 'category', 'categories')} over budget` : null,
    late ? `${plural(late, 'payment')} late` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'One large purchase';
}

function subjectOf(r: WeeklyRecap, detail: RecapDetail): string {
  if (detail === 'minimal') return 'Your week in Fiscus';
  const spent = formatMoney(r.spending.spentMinor, r.currency);
  if (r.quiet) return 'Your week in Fiscus: a quiet one';
  const bills = r.comingUp.filter((c) => c.kind !== 'income');
  const today = bills.filter((c) => c.due === r.today).length;
  const tail = today
    ? `, ${plural(today, 'bill')} coming up today`
    : bills.length
      ? `, ${plural(bills.length, 'bill')} coming up this week`
      : '';
  return `Your week in Fiscus: ${spent} spent${tail}`;
}

const DETAIL_LINE: Record<RecapDetail, string> = {
  full: 'This email has full detail.',
  summary: 'This email has a summary: amounts, but no names.',
  minimal: 'This email has minimal detail: nothing about your money.',
};

const historyLine = (r: WeeklyRecap) =>
  `Activity history: entry ${r.history.seq.toLocaleString('en-US')} · ${r.history.hash
    .slice(0, 8)
    .replace(/(.{4})/, '$1 ')}.`;

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The recap as an email: subject, plain text and HTML (inline styles only, for mail clients). */
export function renderWeeklyRecapEmail(
  recap: WeeklyRecap,
  { detail = 'full', url }: RecapEmailOptions = {},
): RecapEmail {
  const l = lines(recap, detail);
  const keep = 'Keep this email to check later that your household’s history wasn’t rewritten.';
  const settings = `${DETAIL_LINE[detail]} Change it, or stop it, in Settings → Notifications.`;

  const text = [
    l.header.title,
    l.header.sub,
    '',
    ...(detail === 'minimal' ? ['Your weekly recap is ready in Fiscus.', ''] : []),
    ...l.figures.map((f) => `${f.label}: ${f.value}${f.note ? ` (${f.note})` : ''}`),
    ...(l.figures.length ? [''] : []),
    ...(l.quiet ? [l.quiet, ''] : []),
    ...(l.comingUp.length
      ? [
          'Coming up this week',
          ...l.comingUp.map((c) => `  ${c.when}  ${c.what}  ${c.amount}`.trimEnd()),
          '',
        ]
      : []),
    ...(l.worth.length ? ['Worth a look', ...l.worth.map((w) => `  - ${w}`), ''] : []),
    ...(l.review ? [l.review] : []),
    ...(url ? [`Open Fiscus: ${url}`] : []),
    '',
    `${historyLine(recap)} ${keep}`,
    settings,
  ].join('\n');

  const td = 'padding:6px 0;border-top:1px solid #e5e5e0;';
  const section = (title: string, body: string) =>
    `<h2 style="font-size:15px;margin:22px 0 6px">${escape(title)}</h2>${body}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(subjectOf(recap, detail))}</title></head>
<body style="margin:0;padding:24px 16px;background:#f6f6f3;color:#1c1c1a;font:14px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e0;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0">${escape(l.header.title)}</h1>
<p style="margin:2px 0 0;color:#6b6b66">${escape(l.header.sub)}</p>
${detail === 'minimal' ? '<p>Your weekly recap is ready in Fiscus.</p>' : ''}
${
  l.figures.length
    ? `<table role="presentation" style="width:100%;margin-top:18px;border-collapse:collapse"><tr>${l.figures
        .map(
          (f) =>
            `<td style="vertical-align:top;padding-right:12px"><div style="color:#6b6b66;font-size:12px">${escape(f.label)}</div><div style="font-size:18px;font-weight:600">${escape(f.value)}</div>${f.note ? `<div style="color:#6b6b66;font-size:12px">${escape(f.note)}</div>` : ''}</td>`,
        )
        .join('')}</tr></table>`
    : ''
}
${l.quiet ? `<p style="margin-top:18px">${escape(l.quiet)}</p>` : ''}
${
  l.comingUp.length
    ? section(
        'Coming up this week',
        `<table role="presentation" style="width:100%;border-collapse:collapse">${l.comingUp
          .map(
            (c) =>
              `<tr><td style="${td}width:64px;color:#6b6b66">${escape(c.when)}</td><td style="${td}">${escape(c.what)}</td><td style="${td}text-align:right;white-space:nowrap">${escape(c.amount)}</td></tr>`,
          )
          .join('')}</table>`,
      )
    : ''
}
${
  l.worth.length
    ? section(
        'Worth a look',
        `<ul style="margin:0;padding-left:18px">${l.worth.map((w) => `<li>${escape(w)}</li>`).join('')}</ul>`,
      )
    : ''
}
${l.review ? `<p style="margin-top:18px">${escape(l.review)}</p>` : ''}
${url ? `<p><a href="${escape(url)}" style="display:inline-block;background:#1f5f46;color:#ffffff;text-decoration:none;padding:8px 14px;border-radius:8px">Open Fiscus</a></p>` : ''}
<p style="margin-top:22px;border-top:1px solid #e5e5e0;padding-top:12px;color:#6b6b66;font-size:12px">${escape(historyLine(recap))} ${escape(keep)}<br>${escape(settings)}</p>
</div></body></html>`;

  return { subject: subjectOf(recap, detail), text, html };
}
