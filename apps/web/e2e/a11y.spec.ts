// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from './test.js';
import { axeViolations } from './axe.js';

// Automated accessibility checks (#32): every component is on /styleguide, so scanning it in both
// themes covers the design system. Any WCAG 2.2 A/AA violation fails the build.

const violations = axeViolations;

for (const theme of ['light', 'dark'] as const) {
  test.describe(`style guide, ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem('fiscus.theme', t), theme);
      await page.goto('/styleguide');
      await expect(page.getByRole('heading', { level: 1, name: 'Style guide' })).toBeVisible();
      const html = expect(page.locator('html'));
      await (theme === 'dark' ? html.toHaveClass(/dark/) : html.not.toHaveClass(/dark/));
    });

    test('has no accessibility violations', async ({ page }) => {
      expect(await violations(page)).toEqual([]);
    });

    test('has no violations with overlays open', async ({ page }) => {
      await page.getByRole('button', { name: /Category/ }).click();
      await expect(page.getByRole('listbox')).toBeVisible();
      expect(await violations(page)).toEqual([]);
      // Searchable: typing goes to its search box and narrows the list.
      await expect(page.getByRole('searchbox', { name: 'Search' })).toBeFocused();
      await page.keyboard.type('din');
      await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['Dining out']);
      expect(await violations(page)).toEqual([]);
      // The first Escape clears the search, the second closes the list.
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('listbox')).toHaveCount(0);

      await page.getByRole('button', { name: 'Open dialog' }).click();
      await expect(page.getByRole('dialog', { name: 'Rename account' })).toBeVisible();
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Open calendar' }).first().click();
      await expect(
        page.getByRole('dialog', { name: 'Choose a date' }).getByRole('grid'),
      ).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  });
}

test("money and dates are entered in the viewer's format", async ({ page }) => {
  await page.goto('/styleguide');
  const amount = page.getByLabel('Amount (USD)');
  await amount.fill('2,500.5');
  await amount.blur();
  await expect(amount).toHaveValue('$2,500.50');
  await expect(page.getByText('Stored as 250050 (minor units).')).toBeVisible();
});
