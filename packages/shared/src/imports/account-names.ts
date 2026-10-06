// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AccountType } from '../api/accounts.js';

// What an account's name says about its type, for the import wizard's first guess
// (docs/design/imports.md §2). Only a guess: anything wrong is fixed in the wizard or later.
//
// Two tiers, checked in order:
// 1. Words that say what the account is ("checking", "credit card", "mortgage", "IRA"). These win
//    over brand names, so "Amex Savings" is savings and "Home Depot Credit Card" is a card. "Cash"
//    isn't one: it's in too many card names ("Blue Cash", "Double Cash"). Within
//    the tier, loans come first ("Home Equity Loan"), then investments ("Index Fund"), crypto,
//    cards, bank accounts ("Car Fund" is savings), vehicles, and property.
// 2. Brand and product names that mean one type ("Sapphire", "Fidelity", "Navient", "Tesla").
//    Banks that offer everything (Chase, Wells Fargo, Citi) are left out on purpose: the name alone
//    can't tell their checking from their cards.
//
// To add a name: put it in the right list below, as a regular-expression fragment matched as
// whole words, case-insensitively, and add a case to account-names.test.ts. The lists are
// English and US-centric today; names from elsewhere are welcome.

type Hint = [AccountType, string[]];

const KIND_WORDS: Hint[] = [
  [
    'loan',
    [
      'loan',
      'mortgage',
      'heloc',
      'home equity',
      'line of credit',
      'student',
      'auto finance',
      'financing',
    ],
  ],
  [
    'investment',
    [
      'ira',
      'roth',
      '401\\s?\\(?k\\)?',
      '403\\s?\\(?b\\)?',
      '457',
      '529',
      'tsp',
      'sep',
      'hsa',
      'health savings',
      'brokerage',
      'invest(ing|ment|ments)?',
      'individual',
      'joint taxable',
      'taxable',
      'retirement',
      'pension',
      'annuity',
      'stocks?',
      'index fund',
      'mutual fund',
      'etf',
      'rollover',
      'espp',
      'rsu',
    ],
  ],
  ['crypto', ['crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'solana']],
  [
    'credit',
    [
      'credit card',
      // "Credit" alone, but never "credit union".
      'credit(?!\\s+union)',
      'card',
      'charge card',
    ],
  ],
  [
    'depository',
    [
      'checking',
      'chequing',
      'savings?',
      'money market',
      'mma',
      'cd',
      'certificate',
      'share',
      'high yield',
      'hysa',
      'cash management',
      'cash account',
      'debit',
      'spending',
      'fund',
      'emergency',
      'bank',
    ],
  ],
  ['vehicle', ['car', 'truck', 'suv', 'van', 'vehicle', 'motorcycle', 'boat', 'rv', 'camper']],
  [
    'property',
    [
      'house',
      'home',
      'property',
      'condo',
      'townhouse',
      'residence',
      'real estate',
      'rental',
      'land',
    ],
  ],
];

const BRANDS: Hint[] = [
  [
    'credit',
    [
      // Card networks: after the kind words, so "Amex Savings" is savings.
      'visa',
      'mastercard',
      'amex',
      'american express',
      // Card products
      'sapphire',
      'freedom',
      'slate',
      'ink',
      'quicksilver',
      'venture(one)?',
      'savor',
      'platinum',
      'gold',
      'blue cash',
      'cash magnet',
      'everyday',
      'double cash',
      'custom cash',
      'premier',
      'diamond preferred',
      'active cash',
      'autograph',
      'reflect',
      'discover it',
      'apple card',
      'bilt',
      'signature',
      'preferred',
      'rewards',
      'cash back',
      'cashback',
      'unlimited',
      // Co-branded cards
      'prime visa',
      'amazon',
      'costco',
      'skymiles',
      'aadvantage',
      'mileageplus',
      'rapid rewards',
      'bonvoy',
      'hilton honors',
      'world of hyatt',
      'ihg',
      'jetblue',
      'alaska airlines',
      // Store cards
      'redcard',
      "lowe'?s",
      'home depot',
      'best buy',
      "macy'?s",
      "kohl'?s",
      'nordstrom',
      'scheels',
      'rei',
    ],
  ],
  [
    'investment',
    [
      'fidelity',
      'vanguard',
      'schwab',
      'robinhood',
      'e\\*?trade',
      'td ameritrade',
      'merrill( edge)?',
      'wealthfront',
      'betterment',
      'm1',
      'acorns',
      'stash',
      'webull',
      'public',
      'interactive brokers',
      'ibkr',
      'empower',
      'principal',
      'tiaa',
      'ally invest',
      'guideline',
      'voya',
      'transamerica',
      'healthequity',
      'optum',
      'lively',
    ],
  ],
  ['crypto', ['coinbase', 'kraken', 'gemini', 'binance', 'crypto\\.com', 'ledger', 'metamask']],
  [
    'loan',
    [
      'navient',
      'nelnet',
      'mohela',
      'great lakes',
      'sallie mae',
      'aidvantage',
      'edfinancial',
      'fedloan',
      'rocket mortgage',
      'mr\\.? cooper',
      'lightstream',
      'upstart',
      'affirm',
      'klarna',
    ],
  ],
  [
    'depository',
    ['venmo', 'paypal', 'cash app', 'chime', 'ally', 'marcus', 'varo', 'current', 'wise'],
  ],
  [
    'vehicle',
    [
      'toyota',
      'honda',
      'ford',
      'chevrolet',
      'chevy',
      'tesla',
      'subaru',
      'nissan',
      'hyundai',
      'kia',
      'jeep',
      'ram',
      'gmc',
      'bmw',
      'mercedes',
      'audi',
      'volkswagen',
      'vw',
      'mazda',
      'lexus',
      'acura',
      'dodge',
      'rivian',
      'volvo',
      'porsche',
      'harley',
      'f-?150',
      'tacoma',
      'tundra',
      'camry',
      'corolla',
      'rav4',
      'civic',
      'accord',
      'cr-?v',
      'wrangler',
      'silverado',
      'outback',
      'model [3sxy]',
    ],
  ],
  ['property', ['zillow', 'redfin']],
];

const compile = (hints: Hint[]): [AccountType, RegExp][] =>
  hints.map(([type, words]) => [
    type,
    new RegExp(`(?<![\\w'])(${words.join('|')})(?![\\w'])`, 'i'),
  ]);

const KIND = compile(KIND_WORDS);
const BRAND = compile(BRANDS);
/** "123 Main St": a street address is a property. */
const ADDRESS =
  /^\s*\d+\s+.*\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|way|blvd|pl|place|cir|circle|pkwy|ter|terrace)\b/i;

/** The type an account's name implies, or null when it doesn't say. */
export function typeFromName(name: string): AccountType | null {
  // A trademark sign is on card names ("BILT Mastercard®", "Blue Cash Preferred®").
  for (const [type, re] of KIND) if (re.test(name)) return type;
  if (ADDRESS.test(name)) return 'property';
  for (const [type, re] of BRAND) if (re.test(name)) return type;
  if (name.includes('®')) return 'credit';
  return null;
}
