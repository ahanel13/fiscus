// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from './test.js';

// Security headers on every response, errors included (#378, threat model T4).

const paths = [
  '/', // index.html
  '/h/00000000-0000-0000-0000-000000000000/accounts', // a deep link, also index.html
  '/env.js',
  '/assets/missing.js', // nginx's 404
  '/api/v1/me', // the api's 401, through the proxy
];

for (const path of paths) {
  test(`security headers on ${path}`, async ({ request }) => {
    const res = await request.get(path);
    const headers = res.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });
}

test('the policy blocks an injected inline script', async ({ page, cspViolations }) => {
  await page.goto('/login');
  const ran = await page.evaluate(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__injected = true';
    document.head.append(s);
    return new Promise((resolve) =>
      setTimeout(() => resolve((window as unknown as { __injected?: boolean }).__injected), 100),
    );
  });
  expect(ran).toBeUndefined();
  await expect.poll(() => cspViolations.length).toBe(1);
  expect(cspViolations[0]).toMatch(/^script-src-elem blocked inline on /);
  // Expected here; the fixture fails the test on any that remain.
  cspViolations.length = 0;
});
