import { expect, type Page, test } from '@playwright/test';

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
  await page.getByLabel('Time range').selectOption('ytd');
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
  await expect(page.getByLabel('Received $2,410.00')).toHaveText('+$2,410.00');
});
