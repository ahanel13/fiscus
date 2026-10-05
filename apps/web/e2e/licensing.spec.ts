// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';

// AGPL-3.0 §13 and dependency notices (#14).

test('sign-in pages offer the source code and third-party licenses', async ({ page, request }) => {
  await page.goto('/login');
  const source = page.getByRole('link', { name: 'Source code' });
  await expect(source).toHaveAttribute('href', /^https?:\/\//);

  const notices = await request.get('/third-party-licenses.txt');
  expect(notices.ok()).toBe(true);
  const text = await notices.text();
  expect(text).toContain('AGPL-3.0-or-later');
  for (const pkg of ['react ', 'react-aria-components ', '@fontsource-variable/inter ']) {
    expect(text).toContain(`\n${pkg}`);
  }
});
