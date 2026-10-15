// SPDX-License-Identifier: AGPL-3.0-or-later

// Merchant names from bank descriptions (#42). The bank's text is kept as the transaction's
// original description, untouched; this only makes the name people see from it.

/** Card processors put their name before the merchant's: "SQ *BLUE BOTTLE", "TST* SHAKE SHACK". */
export const PROCESSOR_PREFIX =
  /^(sq|tst|sp|pp|paypal|gglpay|google|apl|apple pay|py|in|dd|bt|ck|wpy|pos)\s?\*\s?/i;

/** What banks put before the merchant on card and ACH lines. */
const LEADING_NOISE =
  /^(?:(?:pos|debit card|debit|check ?card|visa|mc|purchase|recurring|preauthorized|ach|dda|pur|web|online|withdrawal)\b[\s:-]*)+(?:authorized on \d{1,2}\/\d{1,2}\s*)?/i;

export const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(
    ' ',
  ),
);

// Initials kept in capitals when a name is title-cased. Short ones without a vowel ("CVS", "DFW",
// "BP") are kept anyway.
const ACRONYMS = new Set(['AMC', 'ATM', 'IRS', 'SSA', 'USA', 'USAA', 'UPS', 'IKEA']);
const MINOR = new Set(['the', 'and', 'of', 'at', 'on', 'in', 'for', 'a', 'to', 'by']);

/** A token that's a store, card, or reference number rather than part of the name. */
const isNumber = (w: string) =>
  /^#/.test(w) ||
  (/\d/.test(w) && !/^\d{1,2}(st|nd|rd|th)$/i.test(w) && !/^\d{1,2}-?[a-z]+$/i.test(w));

/** Title case for a name written in capitals: "BLUE BOTTLE COFFEE" → "Blue Bottle Coffee". */
function titleCase(words: string[]): string[] {
  return words.map((w, i) => {
    const lower = w.toLowerCase();
    if (i > 0 && MINOR.has(lower)) return lower;
    // A word of parts ("CVS/PHARMACY", "J&C", "7-ELEVEN") is cased part by part.
    return w
      .split(/([-&/])/)
      .map((part) => {
        if (ACRONYMS.has(part) || /^[b-df-hj-np-tv-xz]{1,4}$/i.test(part))
          return part.toUpperCase();
        return part.toLowerCase().replace(/^\p{L}/u, (c) => c.toUpperCase());
      })
      .join('');
  });
}

/**
 * The merchant's name from a bank description: processor prefixes, card-line noise, store and
 * reference numbers, and a trailing state removed; title-cased when the bank shouts. Returns the
 * description itself (trimmed) when nothing better is left.
 *
 * "SQ *BLUE BOTTLE COFFEE #1234" → "Blue Bottle Coffee"
 * "POS PURCHASE TRADER JOE S #123 SALT LAKE UT" → "Trader Joe S"
 * "Subway 15048" → "Subway", but "Via 313 Pizza" stays as it is
 */
export function cleanMerchantName(description: string): string {
  const raw = description.trim().replace(/\s+/g, ' ');
  if (!raw) return raw;
  const stripped = raw.replace(LEADING_NOISE, '').replace(PROCESSOR_PREFIX, '').replace(/\*/g, ' ');
  const shouting = /\p{Lu}/u.test(stripped) && !/\p{Ll}/u.test(stripped);
  let words = stripped.split(/\s+/).filter(Boolean);
  // Numbers before the name ("9640 AMC"). In bank capitals, a store number or code and everything
  // after it (the place) goes; a name written normally keeps its numbers ("Via 313 Pizza")
  // except at the end ("Subway 15048").
  while (words.length > 1 && isNumber(words[0]!)) words.shift();
  if (shouting) {
    // Store numbers and codes end the name ("#123", "05123", "F12345"); a short number in the
    // middle is part of it ("VIA 313 PIZZA").
    const cut = words.findIndex(
      (w, i) => i > 0 && isNumber(w) && (i === words.length - 1 || !/^\d{1,3}$/.test(w)),
    );
    if (cut > 0) words = words.slice(0, cut);
    while (words.length > 1 && isNumber(words.at(-1)!)) words.pop();
  } else {
    while (words.length > 1 && isNumber(words.at(-1)!)) words.pop();
  }
  words = words.map((w) => w.replace(/[,;:]+$/, '')).filter((w) => w && !/^[-–—]+$/.test(w));
  while (words.length > 1 && US_STATES.has(words.at(-1)!)) words.pop();
  if (words.length === 0 || (words.length === 1 && isNumber(words[0]!))) return raw;
  return (shouting ? titleCase(words) : words).join(' ');
}
