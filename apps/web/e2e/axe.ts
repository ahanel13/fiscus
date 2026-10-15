// SPDX-License-Identifier: AGPL-3.0-or-later
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * WCAG 2.2 A/AA violations on the page, one line each. React Aria's live announcer is excluded:
 * after a dialog closes it briefly holds an announcement labelled by the dialog's (now removed)
 * title, which axe flags although nothing is on screen. Checked once transitions have finished.
 */
export async function axeViolations(page: Page): Promise<string[]> {
  // Mid-transition colors (a tab just chosen fading to its selected color) fail contrast checks
  // they pass a moment later: wait for running transitions to finish first. Looping animations
  // (spinners) never finish, so they're left alone.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(WCAG)
    .exclude('[data-live-announcer]')
    .analyze();
  return results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.html.slice(0, 160)).join('\n  ')}`,
  );
}
