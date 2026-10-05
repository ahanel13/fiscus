// SPDX-License-Identifier: AGPL-3.0-or-later
// Every source file starts with an SPDX license header (ADR 0007). `--fix` adds missing ones.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ID = 'SPDX-License-Identifier: AGPL-3.0-or-later';
const STYLES = [
  [/\.(c|m)?[jt]sx?$/, `// ${ID}`],
  [/\.css$/, `/* ${ID} */`],
  [/\.sh$/, `# ${ID}`],
  [/\.sql$/, `-- ${ID}`],
];
// Merged migrations are immutable (docs/design/upgrades.md), and env.js is overwritten at
// container start, so neither carries a header.
const SKIP = [/^packages\/db\/migrations\//, /^apps\/web\/public\/env\.js$/];

const fix = process.argv.includes('--fix');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const missing = [];
for (const file of files) {
  const style = STYLES.find(([re]) => re.test(file));
  if (!style || SKIP.some((re) => re.test(file))) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // deleted in the working tree
  }
  // The header goes in the first lines, after a shebang if there is one.
  if (
    text
      .split('\n')
      .slice(0, 3)
      .some((line) => line.includes('SPDX-License-Identifier:'))
  )
    continue;
  missing.push(file);
  if (fix) {
    const header = `${style[1]}\n`;
    writeFileSync(
      file,
      text.startsWith('#!') ? text.replace(/^(#!.*\n)/, `$1${header}`) : header + text,
    );
  }
}

if (missing.length && !fix) {
  console.error(
    `Missing SPDX license header (ADR 0007):\n  ${missing.join('\n  ')}\n\nRun: pnpm spdx:fix`,
  );
  process.exit(1);
}
console.log(
  fix ? `Added SPDX headers to ${missing.length} files.` : 'All source files have SPDX headers.',
);
