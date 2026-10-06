// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from '@playwright/test';
import { axeViolations } from './axe.js';

// One journey through a fresh instance: setup → household → navigate → sign out → sign in.
test.describe.configure({ mode: 'serial' });

const admin = { email: 'admin@e2e.test', password: 'e2e long password', name: 'Ada' };
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
});

test('navigates with the command palette, shortcuts, and the range control', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(householdUrl); // lands in the last household

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Go to/).fill('Budget');
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
  await page.goto(`${householdUrl}/settings`);
  await page.getByLabel('Invite by email').fill('partner@e2e.test');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await expect(page.getByRole('textbox', { name: 'Invite link' })).toHaveValue(/\/invite#token=/);
});

test('adds an account, updates its balance, and shows net worth', async ({ page }) => {
  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  await expect(page.getByRole('heading', { name: 'No accounts yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Add account' }).first().click();

  const dialog = page.getByRole('dialog', { name: 'Add account' });
  await dialog.getByLabel('Name').fill('Everyday checking');
  await dialog.getByLabel('Current balance').fill('2,500');
  await dialog.getByRole('button', { name: 'Add account' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Everyday checking' })).toBeVisible();
  await expect(page.getByText('$2,500.00').first()).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('tab', { name: 'Balances' }).click();
  await page.getByRole('button', { name: 'Update balance' }).click();
  const update = page.getByRole('dialog', { name: 'Update balance' });
  await update.getByLabel('Balance').fill('2,750.25');
  await update.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Balance updated.')).toBeVisible();
  await expect(page.getByText('$2,750.25').first()).toBeVisible();

  await page.getByRole('link', { name: 'Accounts', exact: true }).first().click();
  await expect(page.getByText('Net worth')).toBeVisible();
  await expect(page.getByRole('link', { name: /Everyday checking/ })).toContainText('$2,750.25');
  expect(await axeViolations(page)).toEqual([]);
});

test('records a transaction, categorizes and splits it, and the balance follows', async ({
  page,
}) => {
  await signIn(page);
  // A wallet with no balance entered: its balance is the running total of its transactions.
  await page.goto(`${householdUrl}/accounts`);
  await page.getByRole('button', { name: 'Add account' }).first().click();
  const newAccount = page.getByRole('dialog', { name: 'Add account' });
  await newAccount.getByLabel('Name').fill('Wallet');
  await newAccount.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Wallet' })).toBeVisible();

  await page.goto(`${householdUrl}/transactions`);
  await page.getByRole('button', { name: 'Add transaction' }).click();
  const add = page.getByRole('dialog', { name: 'Add transaction' });
  await add.getByRole('button', { name: /Account/ }).click();
  await page.getByRole('option', { name: 'Wallet' }).click();
  await add.getByLabel('Description').fill('Costco run');
  await add.getByLabel('Amount').fill('120');
  await add.getByRole('button', { name: 'Add transaction' }).click();
  await expect(page.getByText('Transaction added.')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('button', { name: /Costco run/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Costco run' });
  await drawer.getByRole('button', { name: /Category/ }).click();
  await page.getByRole('option', { name: 'Groceries' }).click();
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await drawer.getByRole('button', { name: 'Split' }).click();
  const split = page.getByRole('dialog', { name: 'Split Costco run' });
  await expect(split.getByText('Adds up')).toBeVisible();
  await split.getByRole('button', { name: 'Save split' }).click();
  await expect(page.getByText('Split saved.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Two parts of $60.00 replace the $120.00 purchase in the list.
  await expect(page.getByRole('button', { name: /Costco run \(1\/2\)/ })).toContainText('−$60.00');
  await expect(page.getByRole('button', { name: /Costco run \(2\/2\)/ })).toContainText('−$60.00');

  // The wallet's balance follows its transactions, split or not.
  await page.goto(`${householdUrl}/accounts`);
  await expect(page.getByRole('link', { name: /Wallet/ })).toContainText('−$120.00');
});

test('tags a transaction from a search box, and moves a split purchase to another account', async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`${householdUrl}/accounts`);
  await page.getByRole('button', { name: 'Add account' }).first().click();
  const add = page.getByRole('dialog', { name: 'Add account' });
  await add.getByLabel('Name').fill('Pocket');
  await add.getByRole('button', { name: 'Add account' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pocket' })).toBeVisible();

  await page.goto(`${householdUrl}/transactions`);
  await page.getByRole('button', { name: /Costco run \(1\/2\)/ }).click();
  const drawer = page.getByRole('dialog', { name: /Costco run/ });
  // Tags: only the transaction's own show; others are found or created by typing.
  await expect(drawer.getByText('No tags')).toBeVisible();
  await drawer.getByRole('combobox', { name: 'Add tags' }).fill('Bulk buy');
  await page.getByRole('option', { name: 'Create tag “Bulk buy”' }).click();
  await expect(drawer.getByRole('row', { name: 'Bulk buy' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
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
  await page.getByRole('link', { name: 'Import' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();

  // Made-up rows in the format of a real Monarch export.
  const transactions = [
    'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags,Owner,Reviewed,Id',
    '2026-01-05,Harmons,Groceries,Blue Cash Preferred® ,HARMONS,,-97.55,,Shared,,1',
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
  expect(await axeViolations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Import 4 transactions' }).click();

  await expect(page.getByRole('heading', { name: 'Imported' })).toBeVisible();
  await expect(
    page.getByText(/4 transactions and \d+ balances imported into 3 accounts/),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review 1 transaction' })).toHaveAttribute(
    'href',
    /review=needs_review/,
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
