// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from './test.js';

// Security headers on every response, errors included (#378, threat model T4).

const hh = '/h/00000000-0000-0000-0000-000000000000';

const paths = [
  '/', // index.html
  `${hh}/accounts`, // a deep link, also index.html
  '/env.js',
  '/assets/missing.js', // nginx's 404
  '/api/v1/me', // the api's 401, through the proxy
  // Near the connect page, but not it: none of these allow Plaid (#79).
  `${hh}/connect/plaidx`,
  `${hh}/accounts?next=/connect/plaid`,
  `${hh}/x/connect/plaid`,
  '/connect/plaid',
  '/connect/plaid/oauthx',
  '/connect/plaid/oauth/x',
];

// Plaid Link's script, frame and api are allowed on the connect pages only (#79, threat model T4).
const connectPaths = [
  `${hh}/connect/plaid`,
  `${hh}/connect/plaid/`,
  `${hh}/connect/plaid?connection=00000000-0000-0000-0000-000000000001`,
  `${hh}/connect/plaid/00000000-0000-0000-0000-000000000001`,
  // Back from a bank's own sign-in page (OAuth), for every household.
  '/connect/plaid/oauth',
  '/connect/plaid/oauth?oauth_state_id=00000000-0000-0000-0000-000000000002',
];
const PLAID_SCRIPT_SRC = "script-src 'self' https://cdn.plaid.com;";
const PLAID_CONNECT_SRC = 'https://sandbox.plaid.com https://production.plaid.com;';
const PLAID_FRAME_SRC = 'frame-src https://cdn.plaid.com;';

for (const path of paths) {
  test(`security headers on ${path}`, async ({ request }) => {
    const res = await request.get(path);
    const headers = res.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain('plaid');
    expect(csp).not.toContain('frame-src');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });
}

for (const path of connectPaths) {
  test(`the connect page allows Plaid Link, and only it: ${path}`, async ({ request }) => {
    const res = await request.get(path);
    const headers = res.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp).toContain(PLAID_SCRIPT_SRC);
    expect(csp).toContain(PLAID_FRAME_SRC);
    // Nothing else widens: no inline or eval, styles and requests stay this origin's.
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toMatch(new RegExp(`connect-src 'self'[^;]* ${PLAID_CONNECT_SRC}`));
    expect(csp).toContain("default-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    // The other headers are still there.
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(await res.text()).toContain('<div id="root">');
  });
}

test('other pages refuse Plaid’s script', async ({ page, cspViolations }) => {
  await page.goto('/login');
  const loaded = await page.evaluate(
    (src) =>
      new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve(true);
        s.onerror = () => resolve(false);
        document.head.append(s);
      }),
    'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
  );
  expect(loaded).toBe(false);
  await expect.poll(() => cspViolations.length).toBe(1);
  expect(cspViolations[0]).toMatch(/^script-src-elem blocked https:\/\/cdn\.plaid\.com\//);
  cspViolations.length = 0;
});

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
