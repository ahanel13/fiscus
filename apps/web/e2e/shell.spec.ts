// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from './test.js';
import { axeViolations } from './axe.js';
import { breakConnections, rewriteHistory } from './database.js';
import { stubPlaidLink } from './plaid-link.js';

// One journey through a fresh instance: setup → household → navigate → sign out → sign in.
test.describe.configure({ mode: 'serial' });

const admin = { email: 'admin@e2e.test', password: 'e2e long Password1!', name: 'Ada' };
let householdUrl = '';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  // Wait for the shell to render, so keyboard shortcuts are listening before tests press keys.
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** "Add account" asks how: by hand, or from a file. */
async function addAccountByHand(page: Page) {
  // The header's (an empty Accounts page repeats it in its empty state).
  await page.getByRole('button', { name: 'Add account' }).first().click();
  await page.getByRole('menuitem', { name: 'Enter it yourself' }).click();
}

/** Transactions' "Add" asks how: enter one, or import a file. */
async function enterTransaction(page: Page) {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Enter a transaction' }).click();
}

test('first run: setup creates the admin, then the first household', async ({ page }) => {
  const token = process.env.E2E_SETUP_TOKEN;
  test.skip(!token, 'E2E_SETUP_TOKEN not set');

  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/); // / → login (no session) → setup (empty instance)
  await page.getByLabel('Setup token').fill(token!);
  await page.getByLabel('Your name').fill(admin.name);
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Password').fill(admin.password);
  await page.getByRole('button', { name: 'Create admin account' }).click();

  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel('Household name').fill('E2E Home');
  // On your own, there's no finance style to choose.
  await expect(page.getByText('Yours, mine, and ours')).toHaveCount(0);
  await page.getByText('Me and others').click();
  await page.getByText('Yours, mine, and ours').click();
  await page.getByRole('button', { name: 'Create household' }).click();

  await expect(page).toHaveURL(/\/h\/[0-9a-f-]{36}$/);
  householdUrl = page.url();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  for (const label of ['Accounts', 'Transactions', 'Budget', 'Reports']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
  // Single-member household: no lens and no Shared costs (IA §5).
  await expect(page.getByRole('radiogroup', { name: 'Whose money' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Shared costs' })).toHaveCount(0);
  // What to do next (#354): accounts first; for "Me and others", inviting them; then a review.
  const checklist = page.getByRole('region', { name: /Get set up/ });
  await expect(checklist).toContainText('0 of 3 done');
  await expect(checklist.getByRole('link', { name: 'Add an account' })).toBeVisible();
  await expect(checklist.getByRole('link', { name: 'Import a file' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test('navigates with the command palette, shortcuts, and the range control', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(householdUrl); // lands in the last household
  // The URL can change before the household's shell mounts, and the shell is what listens for
  // shortcuts: wait for it, then press until the palette opens (a slow CI runner).
  await expect(page.getByRole('navigation', { name: 'Main' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const palette = page.getByPlaceholder(/Go to/);
  await expect(async () => {
    if (!(await palette.isVisible())) await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible({ timeout: 1000 });
  }).toPass();
  await palette.fill('Budget');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Budget' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/transactions/);
  // Reports still shows the shared page header's range control (ranges reach the rest in Phase 3).
  await page.goto(`${householdUrl}/reports`);
  await page.getByRole('button', { name: /Time range/ }).click();
  await page.getByRole('option', { name: 'Year to date' }).click();
  await expect(page).toHaveURL(/range=ytd/);

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('creates an invite link from household settings', async ({ page }) => {
  await signIn(page);
  // From the household's menu, on any page.
  await page.goto(householdUrl);
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('button', { name: /E2E Home/ })
    .click();
  await page.getByRole('menuitem', { name: 'Invite someone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite someone to E2E Home' });
  await dialog.getByLabel('Their email').fill('partner@e2e.test');
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Invite link' })).toHaveValue(/\/invite#token=/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  // Waiting to join, until cancelled.
  const waiting = page.getByRole('region', { name: 'Waiting to join' });
  await expect(waiting).toContainText('partner@e2e.test');
  await waiting.getByRole('button', { name: 'Cancel the invite for partner@e2e.test' }).click();
  await expect(page.getByText('Invite cancelled.')).toBeVisible();
  await expect(waiting).toHaveCount(0);
});

test('the admin invites someone to the server, who makes an account and their own household', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('button', { name: /^Ada/ })
    .click();
  await page.getByRole('menuitem', { name: 'Server' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Invite someone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite someone to this server' });
  await dialog.getByLabel('Their email').fill('friend@e2e.test');
  await dialog.getByRole('button', { name: 'Create invite link' }).click();
  const link = await dialog.getByRole('textbox', { name: 'Invite link' }).inputValue();
  expect(link).toMatch(/\/join#token=/);
  await dialog.getByRole('button', { name: 'Done' }).click();
  const waiting = page.getByRole('region', { name: 'Waiting to join' });
  await expect(waiting).toContainText('friend@e2e.test');

  // They open the link signed out, make an account, and start their own household.
  const theirs = await browser.newContext();
  const friend = await theirs.newPage();
  await friend.goto(link);
  await expect(friend.getByRole('heading', { name: 'Join Fiscus' })).toBeVisible();
  expect(await axeViolations(friend)).toEqual([]);
  await friend.getByLabel('Your name').fill('Cam');
  await friend.getByLabel('Password').fill('e2e friend Password1!');
  await friend.getByRole('button', { name: 'Create account' }).click();
  await expect(friend).toHaveURL(/\/welcome$/);
  // The link worked once.
  await friend.goto(link);
  await expect(friend.getByRole('heading', { name: 'Invite not valid' })).toBeVisible();
  await theirs.close();

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Server' })).toBeVisible();
  await expect(waiting).toHaveCount(0);

  // Server → Bank connections (#400): the e2e stack's sandbox keys for its fake Plaid
  // (docker-compose.plaid-stub.yml), SimpleFIN on, every 4 hours.
  const banks = page.getByRole('region', { name: 'Bank connections' });
  await expect(banks.getByText('Configured', { exact: true })).toBeVisible();
  await expect(banks.getByText('Sandbox: no real banks')).toBeVisible();
  await expect(banks.getByRole('switch', { name: /through SimpleFIN/ })).toBeChecked();
  await expect(banks.getByRole('switch', { name: /their own Plaid keys/ })).toBeChecked();
  await expect(banks.getByRole('switch', { name: /Refresh now/ })).toBeChecked();
  expect(await axeViolations(page)).toEqual([]);
  await banks.getByRole('button', { name: /Sync every/ }).click();
  await page.getByRole('option', { name: 'Every 6 hours' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(banks.getByRole('button', { name: /Sync every/ })).toContainText('Every 6 hours');

  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page).toHaveURL(/\/h\/[0-9a-f-]{36}$/);
});

test('adds an account, updates its balance, and shows net worth', async ({ page }) => {
  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  await expect(page.getByRole('heading', { name: 'No accounts yet' })).toBeVisible();
  await addAccountByHand(page);

  const dialog = page.getByRole('dialog', { name: 'Add account' });
  await dialog.getByLabel('Name').fill('Everyday checking');
  await dialog.getByLabel('Current balance').fill('2,500');
  await dialog.getByRole('button', { name: 'Add account' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Everyday checking' })).toBeVisible();
  await expect(page.getByText('$2,500.00').first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // The account's actions live in its ⋯ menu (no tabs, as in Monarch).
  await page.getByRole('button', { name: 'Account actions' }).click();
  await page.getByRole('menuitem', { name: 'Update balance' }).click();
  const update = page.getByRole('dialog', { name: 'Update balance' });
  await update.getByLabel('Balance').fill('2,750.25');
  await update.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Balance updated.')).toBeVisible();
  await expect(page.getByText('$2,750.25').first()).toBeVisible();

  // The balance chart sits above the tabs (#353); the keyboard reads it point by point.
  const chart = page.getByRole('group', { name: 'Everyday checking balance' });
  await chart.focus();
  await page.keyboard.press('End');
  await expect(chart.getByText('$2,750.25')).toBeVisible();
  // The table view of the same numbers.
  await page.getByRole('button', { name: 'Account actions' }).click();
  await page.getByRole('menuitem', { name: 'Balance history' }).click();
  const history = page.getByRole('dialog', { name: 'Balance history' });
  await expect(history.getByRole('grid')).toContainText('$2,750.25');
  expect(await axeViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('link', { name: 'Accounts', exact: true }).first().click();
  await expect(page.getByText('Net worth')).toBeVisible();
  await expect(page.getByRole('link', { name: /Everyday checking/ })).toContainText('$2,750.25');
  await expect(page.getByRole('link', { name: /Everyday checking/ })).toContainText('as of');
  expect(await axeViolations(page)).toEqual([]);

  // The checklist ticks off the account. The invite sent earlier was cancelled, so that's next.
  await page.goto(householdUrl);
  const checklist = page.getByRole('region', { name: /Get set up/ });
  await expect(checklist).toContainText('1 of 3 done');
  await expect(checklist.getByRole('link', { name: 'Invite someone' })).toBeVisible();
  // Hidden, it stays hidden.
  await checklist.getByRole('button', { name: 'Hide' }).click();
  await expect(checklist).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Cash flow/ })).toBeVisible();
  await expect(checklist).toHaveCount(0);
});

test('records a transaction, categorizes and splits it, and the balance follows', async ({
  page,
}) => {
  await signIn(page);
  // A wallet with no balance entered: its balance is the running total of its transactions.
  await page.goto(`${householdUrl}/accounts`);
  await addAccountByHand(page);
  const newAccount = page.getByRole('dialog', { name: 'Add account' });
  await newAccount.getByLabel('Name').fill('Wallet');
  await newAccount.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible();

  await page.goto(`${householdUrl}/transactions`);
  await enterTransaction(page);
  const add = page.getByRole('dialog', { name: 'Add transaction' });
  await add.getByRole('button', { name: /Account/ }).click();
  await page.getByRole('option', { name: 'Wallet' }).click();
  await add.getByLabel('Description').fill('Costco run');
  await add.getByLabel('Amount').fill('120');
  await add.getByRole('button', { name: 'Add transaction' }).click();
  await expect(page.getByText('Transaction added.')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('rowheader', { name: /^Costco run/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Costco run' });
  await drawer.getByRole('button', { name: /Category/ }).click();
  await page.getByRole('option', { name: 'Groceries' }).click();
  // Saved as soon as it's chosen.
  await expect(drawer.getByRole('status')).toHaveText('Saved');
  expect(await axeViolations(page)).toEqual([]);
  // Its history says who did what, newest first (#46).
  const history = drawer.getByRole('region', { name: 'History' });
  await expect(history.getByRole('listitem')).toHaveText([
    /^You set the category to Groceries/,
    /^You added it/,
  ]);

  await drawer.getByRole('button', { name: 'Split' }).click();
  const split = page.getByRole('dialog', { name: 'Split Costco run' });
  await expect(split.getByText('Adds up')).toBeVisible();
  await split.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByText('Split saved.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Two parts of $60.00 replace the $120.00 purchase in the list.
  const part = (n: number) => page.getByRole('row').filter({ hasText: `Costco run (${n}/2)` });
  await expect(part(1)).toContainText('−$60.00');
  await expect(part(2)).toContainText('−$60.00');

  // The wallet's balance follows its transactions, split or not.
  await page.goto(`${householdUrl}/accounts`);
  await expect(page.getByRole('link', { name: /Wallet/ })).toContainText('−$120.00');
});

test('tags a transaction from a search box, and moves a split purchase to another account', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  await addAccountByHand(page);
  const add = page.getByRole('dialog', { name: 'Add account' });
  await add.getByLabel('Name').fill('Pocket');
  await add.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pocket' })).toBeVisible();

  await page.goto(`${householdUrl}/transactions`);
  await page.getByRole('rowheader', { name: /^Costco run \(1\/2\)/ }).click();
  const drawer = page.getByRole('dialog', { name: /Costco run/ });
  // Tags: only the transaction's own show; others are found or created by typing.
  await expect(drawer.getByText('No tags')).toBeVisible();
  await drawer.getByRole('combobox', { name: 'Add tags' }).fill('Bulk buy');
  await page.getByRole('option', { name: 'Create tag “Bulk buy”' }).click();
  await expect(drawer.getByRole('row', { name: 'Bulk buy' })).toBeVisible();
  await expect(drawer.getByRole('status')).toHaveText('Saved');
  expect(await axeViolations(page)).toEqual([]);

  // A part moves with its whole purchase.
  await drawer.getByRole('button', { name: 'Move this purchase to another account' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move this purchase to another account' });
  await dialog.getByRole('button', { name: /Move to account/ }).click();
  await page.getByRole('option', { name: 'Pocket' }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText('Moved to Pocket.')).toBeVisible();

  await page.goto(`${householdUrl}/accounts`);
  await expect(page.getByRole('link', { name: /Pocket/ })).toContainText('−$120.00');
  // Nothing left in the wallet.
  await expect(page.getByRole('link', { name: /Wallet/ })).toContainText('No balance');
});

test('imports a Monarch export with the wizard, then undoes it', async ({ page }) => {
  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  await page.getByRole('button', { name: 'Add account' }).first().click();
  await page.getByRole('menuitem', { name: 'Import from Monarch or a bank file' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();

  // Made-up rows in the format of a real Monarch export.
  const transactions = [
    'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id',
    '2026-01-05,Fresh Market,Groceries,Blue Cash Preferred® ,FRESH MARKET,,-97.55,,Shared,,1',
    '2026-01-06,Payroll,Paychecks,Imported Checking,ACME,,2500.00,,Shared,Needs Review,2',
    '2026-01-07,Amex,Credit Card Payment,Imported Checking,AMEX,,-97.55,,Shared,,3',
    '2026-01-07,Amex,Credit Card Payment,Blue Cash Preferred® ,PAYMENT,,97.55,,Shared,,4',
  ].join('\n');
  const balances = [
    'Date,Balance,Account',
    '2026-01-06,2500.00,Imported Checking',
    '2026-01-07,2402.45,Imported Checking',
    '2025-01-30,10.00,Old Savings',
    '2025-01-31,0.00,Old Savings',
  ].join('\n');
  await page.locator('input[type=file]').setInputFiles([
    { name: 'Transactions.csv', mimeType: 'text/csv', buffer: Buffer.from(transactions) },
    { name: 'Balances.csv', mimeType: 'text/csv', buffer: Buffer.from(balances) },
  ]);
  await expect(page.getByText('Transactions · 4 rows')).toBeVisible();
  await expect(page.getByText('Balances · 4 rows')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Accounts: their names say what they are, so nothing needs a look; Old Savings ended at
  // zero, so it's closed.
  await expect(page.getByRole('heading', { name: 'Where does each account go?' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Ready to import (3)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Check these/ })).toHaveCount(0);
  // Three accounts: short enough to show them all.
  await expect(page.getByRole('checkbox', { name: /Closed from/ })).toBeChecked();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Categories: Groceries and Paychecks match; Credit Card Payment is new.
  await expect(page.getByText('2 matched, 1 new')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('4 new transactions.')).toBeVisible();
  // The card payment is both sides of one transfer: it will be linked.
  const transfers = page.getByRole('region', { name: 'Transfers between your accounts (1)' });
  await expect(transfers).toContainText('Imported Checking → Blue Cash Preferred®');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Import 4 transactions' }).click();

  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
  await expect(
    page.getByText(/4 transactions and \d+ balances imported into 3 accounts/),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review 1 transaction' })).toHaveAttribute(
    'href',
    /\/review$/,
  );

  // Undo removes everything, including the accounts it created.
  await page.getByRole('button', { name: 'Undo this import' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Undo import' }).click();
  await expect(page.getByRole('heading', { name: 'Import undone' })).toBeVisible();
  await page.goto(`${householdUrl}/accounts`);
  await expect(page.getByRole('link', { name: /Imported Checking/ })).toHaveCount(0);
});

test('imports a bank CSV into an existing account, saving the column mapping', async ({ page }) => {
  await signIn(page);
  await page.goto(`${householdUrl}/import`);
  await page.getByText('A bank or card statement').click();
  const csv = [
    'Posting Date,Description,Debit,Credit',
    '01/15/2026,COFFEE SHOP,4.50,',
    '01/16/2026,REFUND,,"1,000.00"',
    '01/32/2026,BAD DATE,1.00,',
  ].join('\n');
  await page.locator('input[type=file]').setInputFiles({
    name: 'bank.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Columns are guessed from the headers and data; the first rows show how they read.
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeFocused();
  await expect(page.getByText('COFFEE SHOP')).toBeVisible();
  await expect(page.getByText('Line 4: The date “01/32/2026”')).toBeVisible();
  await page.getByText('Save this mapping for this bank’s next file').click();
  await page.getByRole('textbox', { name: 'Mapping name' }).fill('E2E bank');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Where This file goes' }).click();
  await page.getByRole('option', { name: 'Wallet' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('2 new transactions, 1 with problems.')).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 transactions' }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();

  // The saved mapping is picked for the next file from this bank.
  await page.goto(`${householdUrl}/import`);
  await page.getByText('A bank or card statement').click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'bank-2.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Using your saved mapping')).toContainText('E2E bank');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Where This file goes' }).click();
  await page.getByRole('option', { name: 'Wallet' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByText('0 new transactions, 2 already imported, 1 with problems.'),
  ).toBeVisible();
});

test('creates a rule with a live preview, and applies it to existing transactions as it does', async ({
  page,
}) => {
  await signIn(page);
  // Rules are a section of household settings, with its own URL (#352).
  await page.goto(`${householdUrl}/settings`);
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await sections.getByRole('link', { name: 'Rules' }).click();
  await expect(page).toHaveURL(/\/settings\/rules$/);
  await expect(sections.getByRole('link', { name: 'Rules' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('No rules yet')).toBeVisible();

  await page.getByRole('button', { name: 'New rule' }).click();
  const editor = page.getByRole('dialog', { name: 'New rule' });
  // It starts with a description and a category; the rest is added as needed (#355).
  await expect(editor.getByRole('textbox', { name: 'Rename to' })).toHaveCount(0);
  await editor.getByRole('textbox', { name: 'Text' }).fill('coffee');
  await editor.getByRole('button', { name: 'Add condition' }).click();
  await page.getByRole('menuitem', { name: 'Money in or out' }).click();
  await editor.getByRole('button', { name: 'Remove: Money in or out' }).click();
  await expect(editor.getByRole('radiogroup', { name: 'Money in or out' })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Add action' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await editor.getByRole('textbox', { name: 'Rename to' }).fill('Coffee');
  await editor.getByRole('button', { name: /Set category/ }).click();
  await page.getByRole('option', { name: 'Coffee', exact: true }).click();
  // The bank CSV's "COFFEE SHOP" from the previous test.
  await expect(editor.getByText(/Would change 1 transaction you can see/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  // Applied to the one it would change, in the same step.
  await expect(
    editor.getByRole('checkbox', { name: 'Apply it to that one now too' }),
  ).toBeChecked();
  await editor.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByText('Rule created.')).toBeVisible();
  await expect(page.getByText(/Applied to 1 existing transaction/)).toBeVisible();
  await expect(page.getByText('When: Description contains “coffee”')).toBeVisible();
  // Opened again, it shows the parts it uses.
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit rule' });
  await expect(edit.getByRole('textbox', { name: 'Rename to' })).toHaveValue('Coffee');
  await page.keyboard.press('Escape');

  // Nothing left for "Apply to existing" to do.
  await page.getByRole('button', { name: 'Apply to existing' }).click();
  const apply = page.getByRole('dialog', { name: 'Apply to existing transactions' });
  await expect(apply).toContainText('Nothing to change');
  expect(await axeViolations(page)).toEqual([]);
  await page.keyboard.press('Escape');

  await page.goto(`${householdUrl}/transactions?range=all_time`);
  // On a desktop, transactions are a table (#351).
  const coffee = page
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: /^Coffee/ }) })
    .filter({ hasText: 'Wallet' });
  await expect(coffee.getByRole('button', { name: /Category of Coffee/ })).toContainText('Coffee');

  // A category can be set from the row itself, and undone from the toast.
  await coffee.getByRole('button', { name: /Category of Coffee/ }).click();
  await page.getByRole('option', { name: 'Restaurants', exact: true }).click();
  await expect(page.getByText('Coffee: Restaurants.')).toBeVisible();
  await expect(coffee.getByRole('button', { name: /Category of Coffee/ })).toContainText(
    'Restaurants',
  );
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(coffee.getByRole('button', { name: /Category of Coffee/ })).toContainText('Coffee');
  // Undo also put back "needs review", which choosing the category had cleared.
  await expect(coffee).toContainText('Review');

  // Sorted by amount: the most money out first, then the most money in (#351).
  const table = page.getByRole('grid', { name: 'Transactions' });
  const amount = table.getByRole('columnheader', { name: 'Amount' });
  const inOrder = async (direction: 1 | -1) => {
    const amounts = (await table.locator('tbody tr td:last-child').allTextContents()).map((t) =>
      Number(t.replace('−', '-').replace(/[^0-9.-]/g, '')),
    );
    return (
      amounts.length > 1 &&
      amounts.every((a, i) => i === 0 || (a - amounts[i - 1]!) * direction >= 0)
    );
  };
  await amount.click();
  await expect(amount).toHaveAttribute('aria-sort', 'ascending');
  await expect.poll(() => inOrder(1)).toBe(true);
  await amount.click();
  await expect(amount).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => inOrder(-1)).toBe(true);
  // The density choice is on the list.
  await page.getByRole('radio', { name: 'Compact' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect(await axeViolations(page)).toEqual([]);
});

test('recategorizing a transaction suggests a rule for next time', async ({ page }) => {
  await signIn(page);
  await page.goto(`${householdUrl}/transactions?range=all_time`);
  await page.getByRole('rowheader', { name: /^Refund/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Refund' });
  await drawer.getByRole('button', { name: /Category/ }).click();
  await page.getByRole('option', { name: 'Interest', exact: true }).click();
  const suggestion = drawer.getByRole('region', { name: 'Rule suggestion' });
  await expect(suggestion).toContainText('When the description contains “REFUND”: Interest.');
  expect(await axeViolations(page)).toEqual([]);
  await suggestion.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByText('Rule created.')).toBeVisible();
  await expect(suggestion).toHaveCount(0);

  // The old address still leads there.
  await page.goto(`${householdUrl}/rules`);
  await expect(page).toHaveURL(/\/settings\/rules$/);
  await expect(page.getByText('When: Description contains “REFUND”')).toBeVisible();
});

test('the dashboard shows cash flow by period, and ranges are remembered', async ({ page }) => {
  await signIn(page);
  await page.goto(householdUrl);
  await expect(page.getByRole('heading', { level: 2, name: /Cash flow/ })).toBeVisible();
  // The wallet's split purchase from the previous test is money out this month.
  await expect(page.getByRole('table', { name: 'Money in and out per period' })).toContainText(
    '$120.00',
  );
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('button', { name: /Time range/ }).click();
  await page.getByRole('option', { name: 'This month' }).click();
  await expect(page).toHaveURL(/range=this_month/);
  await expect(page.getByRole('group', { name: 'Month' })).toBeVisible(); // the period stepper
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page).toHaveURL(/range=custom/);
  await page.getByRole('button', { name: 'This month' }).click();

  // Remembered for this member: a fresh visit without the URL opens on it.
  await page.goto(householdUrl);
  await expect(page.getByRole('button', { name: /Time range/ })).toContainText('This month');
});

test('links a transfer between accounts, and works through the review queue by keyboard', async ({
  page,
}) => {
  await signIn(page);
  // The bank CSV's coffee still needs review (choosing REFUND's category reviewed it): the badge
  // on Transactions says so.
  const nav = page.getByRole('navigation', { name: 'Main' }).first();
  await expect(nav.getByRole('link', { name: /Transactions/ })).toContainText('1');

  // Money out of checking and into the wallet, entered by hand: linked as a transfer.
  await page.goto(`${householdUrl}/transactions`);
  for (const [account, direction, name] of [
    ['Everyday checking', 'Money out', 'To wallet'],
    ['Wallet', 'Money in', 'From checking'],
  ] as const) {
    await enterTransaction(page);
    const add = page.getByRole('dialog', { name: 'Add transaction' });
    await add.getByRole('button', { name: /Account/ }).click();
    await page.getByRole('option', { name: account }).click();
    await add.getByLabel('Description').fill(name);
    await add.getByText(direction, { exact: true }).click();
    await add.getByLabel('Amount').fill('250');
    await add.getByRole('button', { name: 'Add transaction' }).click();
    await expect(add).toHaveCount(0);
  }
  // Filed as a transfer in January, with nothing on the other side: the review will ask.
  await enterTransaction(page);
  const venmo = page.getByRole('dialog', { name: 'Add transaction' });
  await venmo.getByRole('button', { name: /Account/ }).click();
  await page.getByRole('option', { name: 'Everyday checking' }).click();
  await venmo.getByLabel('Description').fill('Venmo Sam');
  await venmo.getByLabel('Amount').fill('80');
  await venmo.getByRole('spinbutton', { name: /month/ }).click();
  await page.keyboard.type('01022026');
  await venmo.getByRole('button', { name: /Category/ }).click();
  await page.getByRole('option', { name: 'Transfer', exact: true }).click();
  await venmo.getByRole('button', { name: 'Add transaction' }).click();
  await expect(venmo).toHaveCount(0);

  await expect(page.getByRole('rowheader', { name: /^To wallet/ })).toContainText(
    'Transfer to Wallet',
  );

  // Unlink, then link it again by hand.
  await page.getByRole('rowheader', { name: /^To wallet/ }).click();
  const drawer = page.getByRole('dialog', { name: 'To wallet' });
  await expect(drawer.getByText('Transfer to Wallet')).toBeVisible();
  await drawer.getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByText('Transfer unlinked.')).toBeVisible();
  await drawer.getByRole('button', { name: 'Link as a transfer' }).click();
  const link = drawer.getByRole('region', { name: 'Link as a transfer' });
  await link.locator('label', { hasText: 'Wallet' }).click();
  expect(await axeViolations(page)).toEqual([]);
  await link.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByText('Linked as a transfer.')).toBeVisible();
  await expect(drawer.getByText('Transfer to Wallet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // The review queue: oldest first, r marks reviewed and moves on.
  await page.getByRole('link', { name: /Review/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
  await expect(page.getByText('1 to review, oldest first.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Reviewing Coffee' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  // Each row says which account it's in.
  const queue = page.getByRole('region', { name: 'To review' });
  await expect(queue.getByRole('listitem')).toHaveText(/Coffee.* · .+ · /);
  // With some checked, the category picker and Mark reviewed are theirs, all at once.
  const coffeeBox = queue.getByRole('checkbox', { name: 'Select Coffee' });
  await coffeeBox.check({ force: true });
  await expect(page.getByRole('button', { name: /Category for 1 checked/ })).toContainText(
    'Coffee',
  );
  await expect(page.getByRole('button', { name: 'Mark 1 reviewed' })).toBeVisible();
  await coffeeBox.uncheck({ force: true });
  await expect(page.getByRole('button', { name: 'Mark reviewed' })).toBeVisible();
  // c opens the category list, ready to search: typing narrows it, Enter picks the first. That
  // closes it, and the keys work again.
  await page.keyboard.press('c');
  await expect(page.getByRole('searchbox', { name: 'Search' })).toBeFocused();
  await page.keyboard.type('coff');
  await expect(
    page.getByRole('listbox').getByRole('option', { name: 'Coffee', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.keyboard.press('r');
  await expect(page.getByText('All caught up')).toBeVisible();

  // Transfers: the Venmo has no other side. It goes to someone outside Fiscus.
  await page.getByRole('button', { name: 'Check 1 transfer' }).click();
  const unmatched = page.getByRole('region', { name: 'No other side (1)' });
  await expect(unmatched).toContainText('Venmo Sam');
  expect(await axeViolations(page)).toEqual([]);
  // The category is a plain button until pressed, then the picker, open (#332).
  await unmatched.getByRole('button', { name: /Recategorize Venmo Sam/ }).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(unmatched.getByRole('button', { name: /Recategorize Venmo Sam/ })).toBeFocused();
  await unmatched.getByRole('button', { name: 'Outside Fiscus' }).click();
  await expect(page.getByText('Transfers add up')).toBeVisible();
  await expect(nav.getByRole('link', { name: /Transactions/ })).not.toContainText('to review');
});

test('a rule can treat payments as transfers to another account, recording the other side', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${householdUrl}/settings/rules`);
  await page.getByRole('button', { name: 'New rule' }).click();
  const editor = page.getByRole('dialog', { name: 'New rule' });
  await editor.getByRole('textbox', { name: 'Text' }).fill('payment to pocket');
  await editor.getByRole('button', { name: 'Add action' }).click();
  await page.getByRole('menuitem', { name: 'Transfer to an account' }).click();
  await editor.getByRole('button', { name: /Transfer to/ }).click();
  await page.getByRole('option', { name: 'Pocket' }).click();
  await editor.getByRole('button', { name: /Look for the other side within/ }).click();
  await page.getByRole('option', { name: '10 days' }).click();
  await editor.getByText('If it isn’t there, record it in Pocket').click();
  await expect(editor.getByText(/up to 10 days before or after/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await editor.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByText('Rule created.')).toBeVisible();
  await expect(
    page.getByText('Transfer to Pocket within 10 days, recorded there if missing').first(),
  ).toBeVisible();
});

test('only the content scrolls: the page and sidebar stay put on a long list', async ({ page }) => {
  // A short window, so the transactions list (with its checkboxes) runs past the bottom.
  await page.setViewportSize({ width: 1280, height: 420 });
  await signIn(page);
  await page.goto(`${householdUrl}/transactions?range=all_time`);
  await expect(page.getByRole('rowheader', { name: /^Refund/ })).toBeVisible();
  const sizes = await page.evaluate(() => ({
    page: document.documentElement.scrollHeight,
    window: window.innerHeight,
    content: document.getElementById('main')!.scrollHeight,
  }));
  expect(sizes.content).toBeGreaterThan(sizes.window); // the list does overflow
  expect(sizes.page).toBeLessThanOrEqual(sizes.window); // but only inside the content area
  // Scrolling over the sidebar moves nothing.
  await page.mouse.move(100, 300);
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('you arrange your own accounts list, and it stays arranged (#48)', async ({ page }) => {
  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  await page.getByRole('button', { name: 'Arrange' }).click();
  await page.getByRole('button', { name: 'New group' }).click();
  const naming = page.getByRole('dialog', { name: 'New group' });
  await naming.getByLabel('Name').fill('Everyday');
  await naming.getByRole('button', { name: 'Add group' }).click();
  const group = page.getByRole('region', { name: 'Everyday', exact: true });
  await expect(group).toContainText('Empty');
  expect(await axeViolations(page)).toEqual([]);

  const row = page.locator('li', { hasText: 'Everyday checking' });
  await row.getByRole('button', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: 'Everyday', exact: true }).click();
  await expect(group).toContainText('Everyday checking');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Done' }).click();

  // Saved: after a reload the account is in the group, as a link again.
  await page.reload();
  await expect(group.getByRole('link', { name: /Everyday checking/ })).toBeVisible();

  // Back to its section, and the group goes.
  await page.getByRole('button', { name: 'Arrange' }).click();
  await row.getByRole('button', { name: 'Move to…' }).click();
  await page.getByRole('menuitem', { name: 'Back to Cash' }).click();
  await expect(group).toContainText('Empty');
  await group.getByRole('button', { name: 'Delete' }).click();
  await expect(group).toHaveCount(0);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Cash', exact: true })
      .getByRole('link', { name: /Everyday checking/ }),
  ).toBeVisible();
});

test('dark mode, sign out, and back', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'dark' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/); // remembered, no flash

  await page.goto(householdUrl);
  await page.getByRole('button', { name: admin.name }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto(householdUrl);
  await expect(page).toHaveURL(/\/login\?redirect=/); // protected routes bounce to login
});

test('phone layout uses bottom tabs instead of the sidebar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(page).toHaveURL(householdUrl);
  const tabs = page.getByRole('navigation', { name: 'Main' }).last();
  await expect(tabs.getByRole('link', { name: 'Transactions' })).toBeVisible();
  await tabs.getByRole('button', { name: 'More' }).click();
  await expect(
    page.getByRole('dialog', { name: 'More' }).getByRole('link', { name: 'Goals' }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false); // no horizontal scrolling at phone width
});

test('the living style guide renders tokens and accessible contrast figures', async ({ page }) => {
  await page.goto('/styleguide');
  await expect(page.getByRole('heading', { level: 1, name: 'Style guide' })).toBeVisible();
  // Every swatch shows a real ratio (catches unparsed or minified color values).
  await expect(page.getByText(/on surface/).first()).toBeVisible();
  await expect(page.getByText(/NaN/)).toHaveCount(0);
  await expect(page.getByLabel('Received $2,410.00').first()).toHaveText('+$2,410.00');
});

test('you choose how you appear; a household that shares everything makes accounts joint', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.goto(`${householdUrl}/settings/members`);
  await expect(page.getByRole('heading', { name: 'How you appear here' })).toBeVisible();
  await page.getByLabel('Your name here').fill('Ada L.');
  await page.getByRole('radiogroup', { name: 'Your color' }).getByText('Violet').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Ada L. (you)')).toBeVisible();

  // A partner joins from an invite link.
  await page.getByRole('button', { name: 'Invite someone' }).click();
  const invite = page.getByRole('dialog', { name: /Invite someone/ });
  await invite.getByLabel('Their email').fill('bea@e2e.test');
  await invite.getByRole('button', { name: 'Create invite link' }).click();
  const link = await invite.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await invite.getByRole('button', { name: 'Done' }).click();
  const partner = await browser.newContext();
  const bea = await partner.newPage();
  await bea.goto(link);
  await bea.getByLabel('Your name').fill('Bea');
  await bea.getByLabel('Password').fill('e2e partner Password1!');
  await bea.getByRole('button', { name: 'Create account and join' }).click();
  await expect(bea).toHaveURL(/\/h\/[0-9a-f-]{36}$/);
  await partner.close();

  // Switching to "it's all ours" offers to make your accounts joint.
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'General' })
    .click();
  await page.getByRole('button', { name: /How you handle money together/ }).click();
  await page.getByRole('option', { name: 'It’s all ours' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const offer = page.getByRole('region', { name: 'Your household shares everything' });
  await expect(offer).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await offer.getByRole('button', { name: /Make all \d+ joint/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Make joint' }).click();
  await expect(page.getByText(/accounts are joint now/)).toBeVisible();
  await expect(offer).toHaveCount(0);
});

test('a rule of your own: just for you, on your accounts, after the household’s (#58)', async ({
  page,
  browser,
}) => {
  await signIn(page);
  await page.goto(`${householdUrl}/settings/rules`);
  const yours = page.getByRole('region', { name: 'Your rules' });
  await expect(page.getByRole('region', { name: 'Household rules' })).toBeVisible();
  await expect(yours).toContainText('None yet');

  await page.getByRole('button', { name: 'New rule' }).click();
  const editor = page.getByRole('dialog', { name: 'New rule' });
  await editor.getByRole('radio', { name: 'Just me' }).click();
  await expect(editor.getByText('Only you see it.')).toBeVisible();
  await editor.getByRole('textbox', { name: 'Text' }).fill('coffee');
  await editor.getByRole('button', { name: 'Add action' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await editor.getByRole('textbox', { name: 'Rename to' }).fill('Morning coffee');
  // The Wallet's coffee from earlier: joint now, and Ada is one of its owners.
  await expect(editor.getByText(/Would change \d+ transactions? you can see/)).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await editor.getByRole('button', { name: 'Create rule' }).click();
  await expect(page.getByText('Rule created.')).toBeVisible();
  await expect(page.getByText(/Applied to \d+ existing transactions?/)).toBeVisible();
  await expect(yours).toContainText('When: Description contains “coffee”');
  expect(await axeViolations(page)).toEqual([]);

  await page.goto(`${householdUrl}/transactions?range=all_time`);
  await expect(page.getByRole('rowheader', { name: /^Morning coffee/ }).first()).toBeVisible();

  // Bea doesn't see it.
  const partner = await browser.newContext();
  const bea = await partner.newPage();
  await bea.goto('/login');
  await bea.getByLabel('Email').fill('bea@e2e.test');
  await bea.getByLabel('Password').fill('e2e partner Password1!');
  await bea.getByRole('button', { name: 'Sign in' }).click();
  await expect(bea).not.toHaveURL(/\/login/);
  await bea.goto(`${householdUrl}/settings/rules`);
  await expect(bea.getByRole('region', { name: 'Household rules' })).toBeVisible();
  await expect(bea.getByRole('region', { name: 'Your rules' })).toContainText('None yet');
  await expect(bea.getByText('Morning coffee')).toHaveCount(0);
  await partner.close();
});

test('imports an OFX file, and finds its accounts by their last 4 digits the next time', async ({
  page,
}) => {
  // Synthetic statements from the parser's fixtures: checking ••1234, savings ••5678, and a card
  // ••9012. The full account numbers never leave the browser.
  const fixture = (name: string) =>
    readFileSync(new URL(`../../../packages/shared/src/imports/fixtures/${name}`, import.meta.url));
  const ofx = {
    name: 'statement.ofx',
    mimeType: 'application/x-ofx',
    buffer: fixture('multi-account.ofx'),
  };
  const steps = page.getByRole('list', { name: 'Import steps' });

  await signIn(page);
  await page.goto(`${householdUrl}/import`);
  await page.getByText('A bank or card statement').click();
  await page.locator('input[type=file]').setInputFiles(ofx);
  await expect(page.getByText('OFX · 3 accounts · 5 transactions')).toBeVisible();
  // OFX labels its values, and has no categories: no columns or categories to match.
  await expect(steps).not.toContainText('Columns');
  await expect(steps).not.toContainText('Categories');
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Where does each account go?' })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Ready to import (3)' })).toBeVisible();
  await expect(page.getByText('••1234 · Checking · balance $1,438.25')).toBeVisible();
  await expect(page.getByText('A new account, Example Bank ••5678.')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('5 new transactions.')).toBeVisible();
  await page.getByRole('button', { name: 'Import 5 transactions' }).click();
  await expect(
    page.getByText(/5 transactions and \d+ balances imported into 3 accounts/),
  ).toBeVisible();

  // The new accounts have the last 4 digits, and the statement's balance.
  await page.goto(`${householdUrl}/accounts`);
  const checking = page.getByRole('link', { name: /Example Bank ••1234/ });
  await expect(checking).toContainText('•••• 1234');
  await expect(checking).toContainText('$1,438.25');

  // The same file again: each account is found by its last 4 digits, and nothing is new.
  await page.goto(`${householdUrl}/import`);
  await page.getByText('A bank or card statement').click();
  await page.locator('input[type=file]').setInputFiles(ofx);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByText('Goes into Example Bank ••1234, which has the same last 4 digits.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('0 new transactions, 5 already imported.')).toBeVisible();

  // A card statement whose purchases read as money in: the card is found, and its amounts can
  // be flipped.
  await page.goto(`${householdUrl}/import`);
  await page.getByText('A bank or card statement').click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'card.qfx',
    mimeType: 'application/vnd.intu.qfx',
    buffer: fixture('card-reversed.qfx'),
  });
  await expect(page.getByText('QFX · 1 account · 3 transactions')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check these (1)' })).toBeVisible();
  await expect(
    page.getByText('Goes into Example Bank ••9012, which has the same last 4 digits.'),
  ).toBeVisible();
  await page.getByText('Amounts are reversed').click();
  await expect(page.getByText('••9012 · Credit card · balance −$767.19')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('3 new transactions.')).toBeVisible();
  await page.getByRole('button', { name: 'Import 3 transactions' }).click();
  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
});

test('connects a bank through Plaid Link, on its own page, and chooses what to track (#79)', async ({
  page,
}) => {
  // Link is stubbed at Plaid's real URL, and the api talks to the stack's fake Plaid: the
  // Riveras' Harbor Credit Union, with checking ••4410, savings ••8812, a Visa and an old savings.
  const link = await stubPlaidLink(page);
  const plaidLoaded = () => page.evaluate(() => 'Plaid' in window);
  const connect = async () => {
    await page.getByRole('button', { name: 'Add account' }).first().click();
    await page.getByRole('menuitem', { name: 'Connect a bank' }).click();
    // A full page load, onto the one page whose policy allows Plaid's script.
    await expect(page).toHaveURL(/\/h\/[0-9a-f-]{36}\/connect\/plaid$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Add a bank account' })).toBeFocused();
  };

  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  // Link stops with an error: you stay, told so, ready to try again.
  link.outcome = 'error';
  await connect();
  await expect(page.getByText('What Fiscus gets')).toBeVisible();
  await expect(page.getByText('Sandbox: Plaid’s test banks only')).toBeVisible();
  const go = page.getByRole('button', { name: 'Continue to Plaid' });
  // Link is made ready as the page loads, not when you press.
  await expect(go).toBeEnabled();
  expect(await axeViolations(page)).toEqual([]);
  await go.click();
  await expect(
    page.getByText('Plaid stopped with an error. Try again in a few minutes.'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/connect\/plaid$/);
  await expect(go).toBeEnabled();
  // Out with a full page load: Plaid's script stays behind.
  await page.getByRole('link', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  expect(await plaidLoaded()).toBe(false);

  link.outcome = 'success';
  await connect();
  await page.getByRole('button', { name: 'Continue to Plaid' }).click();
  await expect(page).toHaveURL(/\/connect\/plaid\/[0-9a-f-]{36}$/);
  const choose = page.getByRole('heading', {
    level: 1,
    name: 'Harbor Credit Union: choose what to track',
  });
  await expect(choose).toBeFocused();
  const setupUrl = page.url();
  expect(link.loads).toBe(2);
  // A reload during setup asks the api for the offer again.
  await page.reload();
  await expect(choose).toBeVisible();
  await expect(page.getByText('Harbor CU Checking')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  // Link the checking account to the one already here, create the savings, skip the rest.
  // Searchable, with your accounts grouped by type, the same kind first.
  const becomes = (name: RegExp) => page.getByRole('combobox', { name });
  const checking = becomes(/What Harbor CU Checking ending in 4410 becomes/);
  await checking.click();
  const menu = page.getByRole('listbox', { name: /What Harbor CU Checking/ });
  await expect(menu.getByText('Cash (checking, savings) (same kind)')).toBeVisible();
  await checking.fill('every');
  await expect(menu.getByRole('option')).toHaveCount(1);
  await menu.getByRole('option', { name: /^Link to Everyday checking/ }).click();
  await expect(checking).toHaveValue('Link to Everyday checking');
  await expect(page.getByText('Keeps its history; sync fills in after it.')).toBeVisible();
  await expect(becomes(/What Harbor CU Savings ending in 8812 becomes/)).toHaveValue('New account');
  for (const name of [/What Harbor CU Visa/, /What Old savings/]) {
    await becomes(name).click();
    // Its own menu: the last one may still be closing.
    await page.getByRole('listbox', { name }).getByRole('option', { name: 'Don’t track' }).click();
  }
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Track 2 accounts' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Harbor Credit Union is connected' }),
  ).toBeFocused();
  const tracked = page.getByRole('list', { name: 'Tracked accounts' }).getByRole('listitem');
  await expect(tracked).toHaveCount(2);
  await expect(tracked.filter({ hasText: 'Everyday checking' })).toContainText('Linked');
  await expect(tracked.filter({ hasText: 'Harbor CU Savings' })).toContainText('New');
  expect(await axeViolations(page)).toEqual([]);

  // Out with a full page load: Plaid's script stays behind.
  await page.getByRole('link', { name: 'Go to accounts' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByRole('link', { name: /Harbor CU Savings/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Everyday checking/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Harbor CU Visa/ })).toHaveCount(0);
  expect(await plaidLoaded()).toBe(false);

  // The same accounts at the same bank again: Fiscus says so before Plaid is asked for them.
  await connect();
  await page.getByRole('button', { name: 'Continue to Plaid' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'You’ve connected Harbor Credit Union already' }),
  ).toBeFocused();
  await expect(page.getByRole('button', { name: 'Connect it anyway' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  // "Go to accounts" when it syncs, else "Cancel" beside the fix (a failing sync, here: the
  // stack's fake Plaid isn't a provider the worker has).
  await page.getByRole('link', { name: /^(Go to accounts|Cancel)$/ }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  // On Accounts: the connection, how fresh it is, and "Refresh now" with its limit (#81, D10).
  const connections = page.getByRole('region', { name: 'Bank connections' });
  await expect(connections).toContainText('Harbor Credit Union · Plaid');
  const refresh = connections.getByRole('button', { name: 'Refresh Harbor Credit Union now' });
  // Enabled once its first sync is done.
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await expect(connections).toContainText(/Synced (just now|\d+ minutes? ago) · next in/);
  expect(await axeViolations(page)).toEqual([]);
  await refresh.click();
  await expect(page.getByText('Syncing Harbor Credit Union now.')).toBeVisible();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveText(/Refresh in 1[45] minutes/);
  await expect(connections).toContainText(/Syncing…|Synced just now · next in \d hours?/);

  // The bank wants a sign-in: everyone sees it, with the accounts it leaves stale (D11, D12), and
  // its owner signs in again through Link's update mode, which keeps the same connection.
  breakConnections(householdUrl.split('/h/')[1]!);
  await page.reload();
  await expect(connections).toContainText('Harbor Credit Union needs you to sign in again');
  await expect(connections).toContainText(/Everyday checking and Harbor CU Savings show balances/);
  expect(await axeViolations(page)).toEqual([]);
  // Its accounts say so on their rows (D13), the dashboard shows it too, and Household settings →
  // Connections lists it with who linked it and "Disconnect" (#89, D14).
  await expect(page.getByRole('link', { name: /Everyday checking.*Needs sign-in/ })).toBeVisible();
  await page.goto(householdUrl);
  await expect(page.getByRole('region', { name: 'Bank connections to fix' })).toContainText(
    'Harbor Credit Union needs you to sign in again',
  );
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(`${householdUrl}/settings/connections`);
  const listed = page.getByRole('region', { name: 'Bank connections' });
  await expect(listed).toContainText('Linked by you · 2 accounts');
  await expect(listed).toContainText('Needs sign-in');
  await expect(listed.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Disconnecting' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(`${householdUrl}/accounts`);
  await connections.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(/\/connect\/plaid\?connection=[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Sign in to your bank again' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Continue to Plaid' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  await expect(page.getByText('Signed in to your bank again.')).toBeVisible();
  await expect(connections).not.toContainText('sign in again');
  expect(await plaidLoaded()).toBe(false);

  // The setup is over: its page says so, and sends you back.
  await page.goto(setupUrl);
  await expect(
    page.getByRole('heading', { level: 1, name: 'This bank is already connected' }),
  ).toBeVisible();
});

test('moves a bank to the household’s own Plaid keys, keeping its accounts (#83)', async ({
  page,
}) => {
  await stubPlaidLink(page);
  await signIn(page);
  await page.goto(`${householdUrl}/settings/connections`);
  // Keys the stack's fake Plaid accepts as a household's own (plaid-stub.ts): Harbor Credit Union,
  // connected above on the server's keys, stays on them until it's moved (D15).
  await page.getByRole('button', { name: 'Add your keys' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add your Plaid keys' });
  await expect(dialog.getByRole('list', { name: 'Banks that keep their keys' })).toContainText(
    'Harbor Credit Union',
  );
  await dialog.getByLabel(/Client ID/).fill('fake-household-client-id-5150');
  await dialog.getByLabel(/Secret/).fill('fake-household-secret-5150');
  await dialog.getByRole('button', { name: /Environment/ }).click();
  await page.getByRole('option', { name: 'Sandbox' }).click();
  await dialog.getByRole('button', { name: 'Save keys' }).click();
  await expect(page.getByText('ending 5150')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Banks not on your keys' })).toContainText(
    'Harbor Credit Union',
  );
  const listed = page.getByRole('region', { name: 'Bank connections' });
  await expect(listed).toContainText('On Plaid keys this household doesn’t connect new banks with');
  expect(await axeViolations(page)).toEqual([]);

  // Moving is connecting it again with the new keys: a full page load onto the connect page.
  await listed.getByRole('button', { name: 'Move to new keys' }).click();
  await expect(page).toHaveURL(/\/connect\/plaid\?replaces=[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Move Harbor Credit Union to new keys' }),
  ).toBeFocused();
  await expect(page.getByText('What stays')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  // The same bank again, and not "connected already": that's the point.
  await page.getByRole('button', { name: 'Continue to Plaid' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Harbor Credit Union: move to new keys' }),
  ).toBeFocused();
  // Its accounts are suggested, by their last 4 digits; the rest start as new ones.
  const becomes = (name: RegExp) => page.getByRole('combobox', { name });
  await expect(becomes(/What Harbor CU Checking ending in 4410 becomes/)).toHaveValue(
    'Link to Everyday checking',
  );
  await expect(becomes(/What Harbor CU Savings ending in 8812 becomes/)).toHaveValue(
    'Link to Harbor CU Savings',
  );
  for (const name of [/What Harbor CU Visa/, /What Old savings/]) {
    await becomes(name).click();
    await page.getByRole('listbox', { name }).getByRole('option', { name: 'Don’t track' }).click();
  }
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Track 2 accounts' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Harbor Credit Union moved to new keys' }),
  ).toBeFocused();
  const tracked = page.getByRole('list', { name: 'Tracked accounts' }).getByRole('listitem');
  await expect(tracked.filter({ hasText: 'Everyday checking' })).toContainText('Linked');
  await expect(tracked.filter({ hasText: 'Harbor CU Savings' })).toContainText('Linked');

  // One connection, on the household's keys, with the same two accounts.
  await page.goto(`${householdUrl}/settings/connections`);
  await expect(listed).toContainText('Linked by you · 2 accounts');
  await expect(listed.getByText(/Harbor Credit Union · Plaid/)).toHaveCount(1);
  await expect(listed.getByRole('button', { name: 'Move to new keys' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Banks not on your keys' })).toHaveCount(0);
});

test('connects the SimpleFIN Bridge with a setup token, claimed once (#91)', async ({ page }) => {
  // The stack's fake Bridge (docker-compose.plaid-stub.yml): its token is base64 of its claim URL.
  const token = Buffer.from('http://plaid-stub:4011/claim/rivera-setup').toString('base64');
  const paste = async () => {
    await page.getByRole('button', { name: 'Add account' }).first().click();
    await page.getByRole('menuitem', { name: 'Connect with SimpleFIN' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect with SimpleFIN' });
    await expect(dialog.getByRole('textbox', { name: 'Setup token' })).toBeFocused();
    return dialog;
  };
  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  let dialog = await paste();
  expect(await axeViolations(page)).toEqual([]);
  // Not a token: said so, nothing claimed.
  await dialog.getByRole('textbox', { name: 'Setup token' }).fill('my bank password');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(dialog.getByText('This isn’t a SimpleFIN setup token.')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Setup token' }).fill(token);
  await dialog.getByRole('button', { name: 'Connect' }).click();

  // The same choose step as Plaid's, on the page every page has (no Plaid script).
  await expect(page).toHaveURL(/\/connect\/setup\/[0-9a-f-]{36}$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'SimpleFIN Bridge: choose what to track' }),
  ).toBeFocused();
  expect(await axeViolations(page)).toEqual([]);
  const becomes = (name: RegExp) => page.getByRole('combobox', { name });
  for (const name of [/What Harbor CU Checking/, /What Harbor CU Savings/, /What Old savings/]) {
    await becomes(name).click();
    // Rows above change height as choices change; the arrow key opens it as a click would.
    const list = page.getByRole('listbox', { name });
    if (!(await list.isVisible())) await becomes(name).press('ArrowDown');
    await list.getByRole('option', { name: 'Don’t track' }).click();
  }
  await expect(becomes(/What Harbor CU Visa/)).toHaveValue('New account');
  await page.getByRole('button', { name: 'Track 1 account' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'SimpleFIN Bridge is connected' }),
  ).toBeFocused();
  await page.getByRole('link', { name: 'Go to accounts' }).click();
  await expect(page).toHaveURL(/\/accounts$/);
  const bridgeLine = page
    .getByRole('region', { name: 'Bank connections' })
    .locator('div', { hasText: 'SimpleFIN Bridge · SimpleFIN' })
    .last();
  await expect(bridgeLine).toBeVisible();
  // The worker syncs it from the stub Bridge: the card and its balance arrive, and the next
  // sync is 6 hours away (the Bridge's daily budget), plus up to 10% jitter: shown as 5 to 7.
  await expect(bridgeLine).toContainText(
    /Synced (just now|\d+ minutes? ago) · next in [5-7] hours/,
    {
      timeout: 30_000,
    },
  );
  await page.reload();
  await expect(page.getByRole('link', { name: /Harbor CU Visa/ })).toBeVisible();

  // Claimed once: the same token again is refused, and says where a new one comes from.
  dialog = await paste();
  await dialog.getByRole('textbox', { name: 'Setup token' }).fill(token);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(
    dialog.getByText('This token has been used. Create a new one at the SimpleFIN Bridge.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

// Last, since it rewrites the household's history in the database. It needs the docker CLI, for
// the compose project in E2E_COMPOSE_PROJECT (default `fiscus`, as CI runs it): e2e/database.ts.
test('your browser notices when the history was rewritten, even consistently (#264)', async ({
  page,
}) => {
  const householdId = householdUrl.split('/h/')[1]!;
  const activity = `/api/v1/households/${householdId}/activity`;
  const check = page.getByRole('region', { name: 'History check' });
  await signIn(page);
  // A new browser: trust on first use, from the check when the household loaded.
  await page.getByRole('link', { name: 'Household settings' }).click();
  await expect(check).toContainText('History checks on this device start now.');

  // Some activity, then a reload: verified, with a fingerprint of the head to compare.
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'Members' })
    .click();
  await page.getByLabel('Your name here').fill('Ada Lovelace');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Ada Lovelace (you)')).toBeVisible();
  // The bank connected earlier syncs in the background, and its syncs are history too: wait
  // until the head stays put, so the one this browser verifies is the one rewritten below.
  const headNow = async () =>
    (
      (await (await page.request.get(`${activity}/proof`)).json()) as {
        data: { head: { seq: number; hash: string } };
      }
    ).data.head;
  let head = await headNow();
  await expect
    .poll(
      async () => {
        const before = head.seq;
        await page.waitForTimeout(2000);
        head = await headNow();
        return head.seq === before;
      },
      { timeout: 60_000, intervals: [0] },
    )
    .toBe(true);
  await page.goto(`${householdUrl}/settings`);
  const print = `${head.hash.slice(0, 4)} ${head.hash.slice(4, 8)}`;
  await expect(check).toContainText('Verified on');
  await expect(check).toContainText(`at entry ${head.seq}, fingerprint ${print}`);
  expect(await axeViolations(page)).toEqual([]);

  // An operator edits an old entry and recomputes the whole chain: the server's own check passes.
  const rewritten = rewriteHistory(householdId);
  expect(rewritten.seq).toBe(head.seq);
  expect(rewritten.hash).not.toBe(head.hash);
  const verify = (await (await page.request.get(`${activity}/verify`)).json()) as {
    data: { ok: boolean };
  };
  expect(verify.data.ok).toBe(true);

  // This browser still remembers the old head, so it warns, on every page of the household.
  await page.reload();
  const banner = page.getByRole('alert').filter({ hasText: 'The history check failed' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`at entry ${head.seq}, fingerprint ${print}`);
  await expect(banner).toContainText('An entry this device verified has changed, or is gone.');
  await expect(check).toContainText('The history check failed.');
  expect(await axeViolations(page)).toEqual([]);
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Accounts' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible();
  await expect(banner).toBeVisible();

  // The report is recorded, as this device's claim, next to the server's (fooled) check.
  await expect(banner).toContainText('This device reported it');
  const feed = (await (await page.request.get(activity)).json()) as {
    data: { action: string; metadata: Record<string, unknown> }[];
  };
  expect(feed.data.find((e) => e.action === 'history.integrity_check_failed')?.metadata).toEqual({
    claim: 'device',
    reason: 'history_diverged',
    lastVerified: { seq: head.seq, hash: head.hash },
    observed: {},
    serverCheck: { ok: true, checkedAt: expect.any(String) },
  });

  // It stays across reloads, until someone here accepts the current history.
  await page.reload();
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Accept current history as the new baseline' }).click();
  await page
    .getByRole('alertdialog', { name: 'Accept the current history?' })
    .getByRole('button', { name: 'Accept as the new baseline' })
    .click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test('starts a budget in one step, and steps through its months (#99, #103)', async ({ page }) => {
  await signIn(page);
  await page.goto(`${householdUrl}/budget`);
  await expect(page.getByRole('heading', { level: 1, name: 'Budget' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Start a budget' })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Start from zero' }).click();
  const month = page.getByRole('group', { name: 'Month' });
  await expect(month).toBeVisible();
  await expect(page.getByText('Category limits')).toBeVisible();
  // The budget starts this month, so there's no going back before it.
  await expect(month.getByRole('button', { name: 'Previous month' })).toBeDisabled();
  await month.getByRole('button', { name: 'Next month' }).click();
  await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
  await month.getByRole('button', { name: 'This month' }).click();
  await expect(month.getByRole('button', { name: 'This month' })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // Categories without a budget are hidden until asked for; a budget is typed into its row.
  await expect(page.getByRole('textbox', { name: /^Groceries: budget for/ })).toHaveCount(0);
  await page.getByText('Show unbudgeted categories', { exact: true }).click();
  const groceries = page.getByRole('textbox', { name: /^Groceries: budget for/ });
  await groceries.click();
  await groceries.fill('250');
  await groceries.press('Enter');
  // Saved: Groceries now has a budget, so it has a bar, and stays shown with the rest hidden.
  await expect(page.getByRole('meter', { name: /^Groceries:/ })).toBeVisible();
  const coffee = page.getByRole('textbox', { name: /^Coffee: budget for/ });
  await coffee.fill('20');
  await coffee.press('Enter');
  await expect(page.getByRole('meter', { name: /^Coffee:/ })).toBeVisible();
  await page.getByText('Show unbudgeted categories', { exact: true }).click();
  await expect(groceries).toHaveValue('$250.00');
  // A group folds up to its totals, and opens again.
  const food = page.getByRole('button', { name: 'Food', exact: true });
  await food.click();
  await expect(food).toHaveAttribute('aria-expanded', 'false');
  await expect(groceries).toHaveCount(0);
  await food.click();
  await expect(groceries).toHaveValue('$250.00');
  // A group's unbudgeted categories show on their own, without the rest.
  const restaurants = page.getByRole('textbox', { name: /^Restaurants: budget for/ });
  await expect(restaurants).toHaveCount(0);
  const foodGroup = page.locator('section').filter({ has: food });
  await foodGroup.getByRole('button', { name: /^Show \d+ unbudgeted$/ }).click();
  await expect(restaurants).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Gas: budget for/ })).toHaveCount(0);
  // Below the budgeted ones, which stay where they were.
  const order = await foodGroup
    .getByRole('textbox')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')?.split(':')[0]));
  expect(order).toEqual(['Groceries', 'Coffee', 'Restaurants']);
  await foodGroup.getByRole('button', { name: /^Hide \d+ unbudgeted$/ }).click();
  await expect(restaurants).toHaveCount(0);
  // Folding the group puts them away again: it reopens with only the budgeted ones.
  await foodGroup.getByRole('button', { name: /^Show \d+ unbudgeted$/ }).click();
  await expect(restaurants).toBeVisible();
  await food.click();
  await food.click();
  await expect(groceries).toHaveValue('$250.00');
  await expect(restaurants).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  // Rollover is two clicks: the category, then the switch. Anywhere in the row but its amount
  // opens it, here beside the amount, in the spent column.
  const box = (await groceries.boundingBox())!;
  await page.mouse.click(box.x + box.width + 40, box.y + box.height / 2);
  const drawer = page.getByRole('dialog', { name: 'Groceries' });
  await drawer.getByText('Roll over what’s left', { exact: true }).click();
  await expect(drawer.getByRole('switch', { name: 'Roll over what’s left' })).toBeChecked();
  // Its amount is typed in there too, as in its row.
  const inDrawer = drawer.getByRole('textbox', { name: /^Groceries: budget for/ });
  await inDrawer.fill('300');
  await inDrawer.press('Enter');
  await expect(drawer.getByRole('img', { name: /budgeted this month \$300\.00/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(groceries).toHaveValue('$300.00');
  await expect(page.getByText('Rollover', { exact: true })).toBeVisible();

  // Categories move between groups in settings, and the budget follows.
  await page.goto(`${householdUrl}/settings/categories`);
  await page.getByRole('button', { name: 'Move Groceries to another group' }).click();
  await page.getByRole('menuitem', { name: /^Fun/ }).click();
  await expect(
    page.getByRole('region', { name: 'Fun', exact: true }).getByText('Groceries'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move Transfer to another group' })).toHaveCount(0);
  await page.goto(`${householdUrl}/budget`);
  await expect(page.getByRole('button', { name: 'Fun', exact: true })).toBeVisible();
});
