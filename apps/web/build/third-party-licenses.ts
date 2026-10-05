// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Plugin } from 'vite';

// Most licenses (MIT, BSD, Apache-2.0) require their notice to travel with copies of the code.
// Minifying strips those comments, so this writes the license of every package actually in the
// bundle to /third-party-licenses.txt, linked from the app's About section.

function packageRoot(id: string): string | undefined {
  const i = id.lastIndexOf(`${sep}node_modules${sep}`);
  if (i < 0) return undefined;
  const rest = id.slice(i + 14).split(sep);
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  return join(id.slice(0, i + 14), ...rest.slice(0, depth));
}

function licenseText(root: string): string | undefined {
  const file = readdirSync(root).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
  return file ? readFileSync(join(root, file), 'utf8').trim() : undefined;
}

export function thirdPartyLicenses(): Plugin {
  return {
    name: 'fiscus-third-party-licenses',
    apply: 'build',
    generateBundle() {
      const roots = new Set<string>();
      for (const id of this.getModuleIds()) {
        const root = packageRoot(id.replace(/^\0/, '').split('?')[0]!);
        if (root && existsSync(join(root, 'package.json'))) roots.add(root);
      }
      const entries = [...roots]
        .map((root) => {
          const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
            name: string;
            version: string;
            license?: string;
            homepage?: string;
          };
          return { ...pkg, text: licenseText(root) ?? licenseText(dirname(root)) };
        })
        // A nested package.json (e.g. a package's "dist/esm") can share a name with its root.
        .filter((p, i, all) => all.findIndex((q) => q.name === p.name) === i)
        .sort((a, b) => a.name.localeCompare(b.name));

      const body = entries
        .map((p) =>
          [
            `${p.name} ${p.version}`,
            `License: ${p.license ?? 'see below'}`,
            ...(p.homepage ? [`Homepage: ${p.homepage}`] : []),
            '',
            p.text ?? `(No license file in the package. License field: ${p.license ?? 'none'}.)`,
          ].join('\n'),
        )
        .join(`\n\n${'-'.repeat(78)}\n\n`);

      this.emitFile({
        type: 'asset',
        fileName: 'third-party-licenses.txt',
        source:
          'Fiscus is licensed under AGPL-3.0-or-later. It includes the following open-source\n' +
          `packages, each under its own license (${entries.length} packages).\n\n${'='.repeat(78)}\n\n${body}\n`,
      });
    },
  };
}
