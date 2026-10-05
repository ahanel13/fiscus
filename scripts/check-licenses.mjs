// SPDX-License-Identifier: AGPL-3.0-or-later
// Fails if any dependency's license is incompatible with AGPL-3.0-or-later (ADR 0007).
//
// Shipped dependencies (in Docker images and the web bundle) must use a license on SHIPPED.
// Build and test tools may also use DEV_ONLY licenses, since they're never distributed.
// Anything else needs an entry in EXCEPTIONS with the reason, reviewed like code.
import { execFileSync } from 'node:child_process';

/** Compatible with distributing the combined work under AGPL-3.0-or-later. */
const SHIPPED = new Set([
  '0BSD',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0',
  'CC0-1.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1', // fonts (Inter); the font stays under OFL inside the app
  'Python-2.0',
  'Unlicense',
  'Zlib',
]);

/** Fine for tools that are never shipped (e.g. browser-support data used at build time). */
const DEV_ONLY = new Set(['CC-BY-3.0', 'CC-BY-4.0']);

/** Packages whose metadata is missing or wrong, checked by hand. Keep the reason current. */
const EXCEPTIONS = {
  '@react-aria/optimize-locales-plugin':
    'Apache-2.0: the package ships Adobe\'s Apache-2.0 LICENSE and headers, but its package.json has no "license" field. Build-time only.',
};

const list = (prod) =>
  JSON.parse(
    execFileSync('pnpm', ['-r', 'licenses', 'list', '--json', ...(prod ? ['--prod'] : [])], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

/** "MIT OR Apache-2.0" passes if either does; "Apache-2.0 AND MIT" needs both. */
function allowed(expression, ok) {
  const e = expression.replace(/[()]/g, '').trim();
  if (/ OR /i.test(e)) return e.split(/ OR /i).some((part) => allowed(part, ok));
  return e.split(/ AND /i).every((part) => ok.has(part.trim()));
}

const shipped = new Set();
for (const pkgs of Object.values(list(true))) for (const p of pkgs) shipped.add(p.name);

const problems = [];
const usedExceptions = new Set();
for (const [license, pkgs] of Object.entries(list(false))) {
  for (const p of pkgs) {
    const isShipped = shipped.has(p.name);
    const ok = isShipped ? SHIPPED : new Set([...SHIPPED, ...DEV_ONLY]);
    if (allowed(license, ok)) continue;
    if (EXCEPTIONS[p.name]) {
      usedExceptions.add(p.name);
      continue;
    }
    problems.push(
      `${p.name}@${p.versions.join(', ')}: ${license}${isShipped ? ' (shipped)' : ' (dev only)'}`,
    );
  }
}

// Stale exceptions hide nothing today but could hide a problem tomorrow.
for (const name of Object.keys(EXCEPTIONS)) {
  if (!usedExceptions.has(name)) problems.push(`${name}: exception no longer needed; remove it`);
}

if (problems.length) {
  console.error(
    `Dependency licenses not compatible with AGPL-3.0-or-later (ADR 0007):\n  ${problems.join('\n  ')}\n\n` +
      'Choose another package, or if the metadata is wrong, add a reviewed entry to EXCEPTIONS in scripts/check-licenses.mjs.',
  );
  process.exit(1);
}
console.log(
  `All dependency licenses are AGPL-compatible (${shipped.size} shipped packages checked).`,
);
