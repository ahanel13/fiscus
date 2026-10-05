// SPDX-License-Identifier: AGPL-3.0-or-later
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

// Automated accessibility checks (#32): every component is on /styleguide, so scanning it in both
// themes covers the design system. Any WCAG 2.2 A/AA violation fails the build.

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function violations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  return results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.html.slice(0, 160)).join('\n  ')}`,
  );
}

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
      await page.keyboard.press('Escape');

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
