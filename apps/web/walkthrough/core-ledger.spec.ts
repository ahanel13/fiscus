// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Browser, expect, type Page, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Screenshots for docs/design/walkthroughs/core-ledger.md: one made-up household (the Riveras)
// from first run through import, review, rules, transfers, and inviting a partner. All data here
// is invented. Re-run after UI changes to refresh the images.
test.describe.configure({ mode: 'serial' });

const OUT = resolve(
  process.env.WALKTHROUGH_OUT ??
    `${import.meta.dirname}/../../../docs/design/walkthroughs/core-ledger`,
);
mkdirSync(OUT, { recursive: true });

const alex = { email: 'alex@example.com', password: 'Walkthrough pass 1!', name: 'Alex' };
const sam = { email: 'sam@example.com', password: 'Walkthrough pass 2!', name: 'Sam' };
let home = '';

/**
 * A desktop screenshot. `whole` captures all of the content: only the content area scrolls in the
 * app, so the window is made tall enough for it first.
 */
async function shot(page: Page, name: string, whole = false) {
  await page.waitForTimeout(400); // let transitions settle
  if (!whole) {
    await page.screenshot({ path: `${OUT}/${name}.png` });
    return;
  }
  const size = page.viewportSize()!;
  const height = await page.evaluate(() => {
    const main = document.querySelector('#main');
    return main
      ? main.scrollHeight + main.getBoundingClientRect().top
      : document.documentElement.scrollHeight;
  });
  await page.setViewportSize({
    width: size.width,
    height: Math.min(Math.max(height, size.height), 2400),
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.setViewportSize(size);
}

/** The same page on a phone, signed in as the desktop page is. */
async function onPhone(browser: Browser, page: Page, url: string) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    storageState: await page.context().storageState(),
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
  });
  const phone = await context.newPage();
  await phone.goto(url);
  await expect(phone.getByRole('heading', { level: 1 })).toBeVisible();
  return phone;
}

async function signIn(page: Page, who = alex) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

// A made-up Monarch export, dated relative to today so the default ranges show it.
const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
function monarchExport() {
  const rows: string[][] = [];
  const t = (
    ago: number,
    merchant: string,
    category: string,
    account: string,
    amount: number,
    reviewed = '',
  ) =>
    rows.push([
      day(ago),
      merchant,
      category,
      account,
      merchant.toUpperCase(),
      '',
      amount.toFixed(2),
      '',
      'Shared',
      reviewed,
    ]);
  const checking = 'Joint Checking';
  const card = 'Visa Signature (...1234)';
  for (const ago of [70, 56, 42, 28, 14]) t(ago, 'Acme Corp', 'Paychecks', checking, 2850);
  for (const ago of [44, 14]) t(ago, 'Parkside Apartments', 'Rent or mortgage', checking, -1950);
  t(40, 'City Power', 'Utilities', checking, -132.4);
  t(10, 'City Power', 'Utilities', checking, -128.9);
  t(35, 'FiberNet', 'Internet and phone', checking, -70);
  t(5, 'FiberNet', 'Internet and phone', checking, -70);
  for (const [ago, amount] of [
    [38, -142.18],
    [31, -96.4],
    [24, -118.75],
    [17, -84.2],
    [9, -131.06],
    [3, -76.5],
  ] as const)
    t(ago, 'Fresh Market', 'Groceries', card, amount);
  for (const ago of [33, 26, 19, 12, 6, 2]) t(ago, 'Bean There', 'Coffee', card, -4.75);
  t(22, 'Taco Stand', 'Restaurants', card, -32.1);
  t(8, 'QuickFuel', 'Gas', card, -45.02);
  t(4, 'Amazon', 'Uncategorized', card, -48.99, 'Needs Review');
  t(2, 'Corner Hardware', 'Uncategorized', card, -23.17, 'Needs Review');
  // The card paid from checking: both sides, a day apart. Linked on import.
  t(20, 'Visa payment', 'Credit Card Payment', checking, -612.34);
  t(19, 'Payment thank you', 'Credit Card Payment', card, 612.34);
  // Into savings, two days later: linked too.
  t(30, 'Transfer to savings', 'Transfer', checking, -500);
  t(28, 'Transfer from checking', 'Transfer', 'High-Yield Savings', 500);
  // Into the brokerage, 9 days later: too far apart to link on its own.
  t(25, 'Brokerage deposit', 'Transfer', checking, -1000);
  t(16, 'Contribution', 'Transfer', 'Brokerage', 1000);
  // Two $200 deposits into savings the same day, one from each account: ambiguous.
  t(12, 'To High-Yield Savings', 'Transfer', 'Holiday Fund', -200);
  t(12, 'To High-Yield Savings', 'Transfer', checking, -200);
  t(12, 'From Holiday Fund', 'Transfer', 'High-Yield Savings', 200);
  t(12, 'From Checking', 'Transfer', 'High-Yield Savings', 200);
  t(66, 'Opening deposit', 'Savings transfers', 'Holiday Fund', 1500);
  // Money to a friend, filed as a transfer: no other side in Fiscus.
  t(20, 'Venmo Jordan', 'Transfer', checking, -80);
  t(1, 'Interest', 'Interest', 'High-Yield Savings', 12.34);
  const transactions = [
    'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id',
    ...rows.map((r, i) => [...r, String(1000 + i)].join(',')),
  ].join('\n');
  const balances = ['Date,Balance,Account'];
  for (let w = 10; w >= 0; w--)
    balances.push(`${day(w * 7)},${(24_000 + (10 - w) * 190).toFixed(2)},Brokerage`);
  balances.push('2025-03-01,1000.00,Old Savings', '2025-03-02,0.00,Old Savings');
  return { transactions, balances: balances.join('\n') };
}

test('1. first run: setup, then the household', async ({ page }) => {
  const token = process.env.E2E_SETUP_TOKEN;
  test.skip(!token, 'E2E_SETUP_TOKEN not set');
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel('Setup token').fill(token!);
  await page.getByLabel('Your name').fill(alex.name);
  await page.getByLabel('Email').fill(alex.email);
  await page.getByLabel('Password').fill(alex.password);
  await shot(page, '01-setup');
  await page.getByRole('button', { name: 'Create admin account' }).click();

  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel('Household name').fill('The Riveras');
  await page.getByText('Me and others').click();
  await page.getByText('Yours, mine, and ours').click();
  await shot(page, '02-welcome', true);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page).toHaveURL(/\/h\/[0-9a-f-]{36}$/);
  home = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await shot(page, '03-dashboard-empty');
});

test('2. accounts: empty, add one by hand', async ({ page }) => {
  await signIn(page);
  await page.goto(`${home}/accounts`);
  await expect(page.getByRole('heading', { name: 'No accounts yet' })).toBeVisible();
  await shot(page, '04-accounts-empty');
  await page.getByRole('button', { name: 'Add account' }).first().click();
  await expect(page.getByRole('menuitem', { name: 'Enter it yourself' })).toBeVisible();
  await shot(page, '05-add-account-menu');
  await page.getByRole('menuitem', { name: 'Enter it yourself' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add account' });
  await dialog.getByLabel('Name').fill('Cash wallet');
  await dialog.getByLabel('Current balance').fill('60');
  await shot(page, '06-add-account-dialog');
  await dialog.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Cash wallet' })).toBeVisible();
  await shot(page, '07-account-detail-new');
});

test('3. import a Monarch export', async ({ page }) => {
  await signIn(page);
  await page.goto(`${home}/accounts`);
  await page.getByRole('button', { name: 'Add account' }).first().click();
  await page.getByRole('menuitem', { name: 'Import from Monarch or a bank file' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  await shot(page, '08-import-start');
  const { transactions, balances } = monarchExport();
  await page.locator('input[type=file]').setInputFiles([
    { name: 'Transactions.csv', mimeType: 'text/csv', buffer: Buffer.from(transactions) },
    { name: 'Balances.csv', mimeType: 'text/csv', buffer: Buffer.from(balances) },
  ]);
  await expect(page.getByText(/Transactions · \d+ rows/).first()).toBeVisible();
  await shot(page, '09-import-files');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Where does each account go?' })).toBeVisible();
  await shot(page, '10-import-accounts', true);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/matched/).first()).toBeVisible();
  await shot(page, '11-import-categories', true);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/new transactions/).first()).toBeVisible();
  await shot(page, '12-import-preview', true);
  await page.getByRole('button', { name: /^Import \d+ transactions/ }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
  await shot(page, '13-import-done');

  await page.goto(`${home}/accounts`);
  await expect(page.getByText('Net worth')).toBeVisible();
  await shot(page, '14-accounts-list', true);
  await page.getByRole('link', { name: /Brokerage/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Brokerage' })).toBeVisible();
  await shot(page, '15-account-detail');
});

test('4. import a bank CSV into an account', async ({ page }) => {
  await signIn(page);
  await page.goto(`${home}/import`);
  await page.getByText('A bank or card statement').click();
  const csv = [
    'Posting Date,Description,Debit,Credit',
    `${day(6).slice(5, 7)}/${day(6).slice(8)}/${day(6).slice(0, 4)},FARMERS MARKET,18.00,`,
    `${day(3).slice(5, 7)}/${day(3).slice(8)}/${day(3).slice(0, 4)},BEAN THERE CAFE,4.75,`,
    '13/45/2026,ATM WITHDRAWAL,40.00,',
  ].join('\n');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'wallet.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
  await shot(page, '16-csv-columns', true);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Where This file goes' }).click();
  await page.getByRole('option', { name: 'Cash wallet' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/with problems/).first()).toBeVisible();
  await shot(page, '17-csv-preview', true);
  await page.getByRole('button', { name: /^Import \d+ transactions/ }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
});

test('5. transactions: the list, the drawer, a split', async ({ page, browser }) => {
  await signIn(page);
  await page.goto(`${home}/transactions`);
  await expect(page.getByRole('rowheader', { name: /^Amazon/ })).toBeVisible();
  await shot(page, '18-transactions');
  // The category is set from the row.
  await page.getByRole('button', { name: /Category of Amazon/ }).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await shot(page, '18b-row-category');
  await page.keyboard.press('Escape');
  const phone = await onPhone(browser, page, `${home}/transactions`);
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: `${OUT}/19-transactions-phone.png` });
  await phone.getByRole('button', { name: /Filters/ }).click();
  await phone.waitForTimeout(400);
  await phone.screenshot({ path: `${OUT}/20-filters-phone.png` });
  await phone.context().close();

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await shot(page, '21-add-menu');
  await page.keyboard.press('Escape');

  // Recategorize: the drawer suggests a rule for next time.
  await page.getByRole('rowheader', { name: /^Corner Hardware/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Corner Hardware' });
  await expect(drawer).toBeVisible();
  await shot(page, '22-drawer');
  await drawer.getByRole('button', { name: /Category/ }).click();
  await page.getByRole('option', { name: 'Home maintenance', exact: true }).click();
  const suggestion = drawer.getByRole('region', { name: 'Rule suggestion' });
  await expect(suggestion).toBeVisible();
  await suggestion.scrollIntoViewIfNeeded();
  await shot(page, '23-rule-suggestion');
  await page.keyboard.press('Escape');

  // Split a grocery run: part of it was household supplies.
  await page
    .getByRole('rowheader', { name: /^Fresh Market/ })
    .first()
    .click();
  const grocery = page.getByRole('dialog', { name: 'Fresh Market' });
  await grocery.getByRole('button', { name: 'Split' }).click();
  const split = page.getByRole('dialog', { name: 'Split Fresh Market' });
  await expect(split.getByText('Adds up')).toBeVisible();
  await shot(page, '24-split');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
});

test('6. the review queue', async ({ page }) => {
  await signIn(page);
  await page.goto(`${home}/review`);
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Reviewing/ })).toBeVisible();
  await page.evaluate(() => document.querySelector('#main')?.scrollTo(0, 0));
  await shot(page, '25-review');
});

test('7. rules', async ({ page }) => {
  await signIn(page);
  await page.goto(`${home}/settings/rules`);
  await page.getByRole('button', { name: 'New rule' }).click();
  const editor = page.getByRole('dialog', { name: 'New rule' });
  await editor.getByRole('textbox', { name: 'Text' }).fill('bean there');
  await editor.getByRole('textbox', { name: 'Rename to' }).fill('Bean There');
  await editor.getByRole('button', { name: /Set category/ }).click();
  await page.getByRole('option', { name: 'Coffee', exact: true }).click();
  await expect(editor.getByText(/Would change \d+ transaction/)).toBeVisible();
  await editor.getByRole('checkbox', { name: /Apply it to/ }).scrollIntoViewIfNeeded();
  await shot(page, '26-rule-editor');
  await editor.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByText('Rule created.')).toBeVisible();
  await shot(page, '27-rules-list');
});

test('8. checking transfers', async ({ page }) => {
  await signIn(page);
  await page.goto(`${home}/review`);
  await page.getByText(/^Transfers \(/).click();
  await expect(page.getByRole('heading', { name: /Suggested pairs/ })).toBeVisible();
  await shot(page, '29-transfer-review', true);
  await page
    .getByRole('button', { name: /^Link Holiday Fund .* to High-Yield Savings From Holiday Fund/ })
    .click();
  await expect(page.getByText('Linked as a transfer.')).toBeVisible();
  await page.waitForTimeout(1500); // the refetch brings in what the link settled
  await shot(page, '30-transfer-review-after', true);
});

test('9. people: a partner joins, and the lens appears', async ({ page, browser }) => {
  await signIn(page);
  await page.goto(home);
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('button', { name: /The Riveras/ })
    .click();
  await shot(page, '31-household-menu');
  await page.getByRole('menuitem', { name: 'Invite someone' }).click();
  const dialog = page.getByRole('dialog', { name: /Invite someone/ });
  await dialog.getByLabel('Their email').fill(sam.email);
  await shot(page, '32-invite-dialog');
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  const link = await dialog.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await shot(page, '33-invite-link');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const theirs = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const partner = await theirs.newPage();
  await partner.goto(link);
  await expect(partner.getByRole('heading', { name: /Join The Riveras/ })).toBeVisible();
  await partner.screenshot({ path: `${OUT}/34-join-household-phone.png` });
  await partner.getByLabel('Your name').fill(sam.name);
  await partner.getByLabel('Password', { exact: true }).fill(sam.password);
  await partner.getByRole('button', { name: 'Create account and join' }).click();
  await expect(partner).toHaveURL(/\/h\/[0-9a-f-]{36}$/);
  await theirs.close();

  await page.goto(`${home}/settings/members`);
  await expect(page.getByText('Sam').first()).toBeVisible();
  await shot(page, '35-household-settings', true);
  await page.goto(home);
  await expect(page.getByRole('radiogroup', { name: 'Whose money' })).toBeVisible();
  await shot(page, '36-dashboard');

  // A link that's been used shows why it doesn't work.
  const used = await browser.newContext();
  const again = await used.newPage();
  await again.goto(link);
  await expect(again.getByRole('heading', { name: 'Invite not valid' })).toBeVisible();
  await again.screenshot({ path: `${OUT}/37-invite-used.png` });
  await used.close();
});

test('10. the server: inviting someone to start their own household', async ({ page }) => {
  await signIn(page);
  await page.goto('/server');
  await page.getByRole('button', { name: 'Invite someone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite someone to this server' });
  await dialog.getByLabel('Their email').fill('jordan@example.com');
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Invite link' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);
  await shot(page, '38-server');
});
