// SPDX-License-Identifier: AGPL-3.0-or-later
// Renders each prototype to a PNG next to bank-sync.md (README.md says how to run it).
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Playwright comes from the web app's dependencies: run from apps/web (README.md).
const require = createRequire(join(process.cwd(), 'package.json'));
const { chromium } = require('@playwright/test');

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..');
const browser = await chromium.launch();
for (const file of readdirSync(here)
  .filter((f) => f.endsWith('.html'))
  .sort()) {
  const phone = file.includes('phone');
  const page = await browser.newPage({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 860 },
    deviceScaleFactor: phone ? 2 : 1,
  });
  await page.goto(`file://${join(here, file)}`);
  await page.screenshot({ path: join(out, file.replace('.html', '.png')) });
  await page.close();
}
await browser.close();
