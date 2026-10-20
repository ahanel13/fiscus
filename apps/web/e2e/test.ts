// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test as base } from '@playwright/test';

/**
 * Playwright's test, where any Content-Security-Policy violation fails the test (#378). The page
 * reports each one, on every navigation, through a binding set up before any of its scripts run.
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ page }, use) => {
      const violations: string[] = [];
      await page.exposeBinding('__fiscusCspViolation', (_source, line: string) => {
        violations.push(line);
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          const report = (window as unknown as Record<string, (line: string) => void>)
            .__fiscusCspViolation;
          report?.(
            `${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} on ${e.documentURI}` +
              (e.sourceFile ? ` (from ${e.sourceFile}:${e.lineNumber}:${e.columnNumber})` : ''),
          );
        });
      });
      await use(violations);
      expect(violations, 'Content-Security-Policy violations').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
export type { Page } from '@playwright/test';
