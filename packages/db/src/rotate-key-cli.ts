#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { envKeyProvider, KeyConfigError, type MasterKeys } from '@fiscus/crypto';
import { describeError, exitOnUnhandled, loadEnvOrExit } from '@fiscus/env';
import { masterKeyUsage, rewrapHouseholdKeys } from './household-key-store.js';
import { runMaintenanceJob } from './maintenance.js';
import rotateEnv from './rotate-env.js';

// Master key rotation (docs/security/encryption.md, #25): re-wraps every household data key
// that an older master key wraps with APP_ENCRYPTION_KEY. With --check, only reports which
// master key versions are in use. Exits 1 while anything still needs a key other than the
// current one, so a script can tell when APP_ENCRYPTION_KEY_PREVIOUS can go.

const env = loadEnvOrExit(rotateEnv);
exitOnUnhandled((message) => console.error(`[rotate-key] ${message}`));
const check = process.argv.includes('--check');

let keys: MasterKeys;
try {
  keys = await envKeyProvider(env).masterKeys();
} catch (err) {
  console.error(`[rotate-key] ${err instanceof KeyConfigError ? err.message : describeError(err)}`);
  process.exit(1);
}
const current = keys.current.version;

const usage = (counts: Map<number, number>) =>
  [...counts]
    .sort(([a], [b]) => a - b)
    .map(([v, n]) => `v${v}: ${n} household ${n === 1 ? 'key' : 'keys'}`)
    .join(', ') || 'no household keys yet';

const result = await runMaintenanceJob(
  env.MAINTENANCE_DATABASE_URL,
  {
    job: 'master-key-rewrap',
    reason: check ? 'check' : `to master key v${current}`,
  },
  async (db) => {
    const done = check ? null : await rewrapHouseholdKeys(db, keys);
    return { done, counts: await masterKeyUsage(db) };
  },
);

if (result.done) {
  console.log(`[rotate-key] re-wrapped ${result.done.rewrapped} with master key v${current}`);
  for (const { version, keys: n } of result.done.missing) {
    console.error(
      `[rotate-key] ${n} wrapped with master key v${version}, which isn't loaded: set it as APP_ENCRYPTION_KEY_PREVIOUS (APP_ENCRYPTION_KEY_PREVIOUS_VERSION=${version}) and run this again.`,
    );
  }
}
console.log(`[rotate-key] master keys in use: ${usage(result.counts)}`);
const others = [...result.counts.keys()].filter((v) => v !== current);
if (others.length) {
  console.log(
    `[rotate-key] still needed: v${others.join(', v')}. Keep APP_ENCRYPTION_KEY_PREVIOUS${check ? ', and run without --check' : ''}.`,
  );
  process.exit(1);
}
console.log(
  `[rotate-key] everything uses master key v${current}. APP_ENCRYPTION_KEY_PREVIOUS can be removed from the services; keep a copy of it while you keep backups from before the rotation, which still need it.`,
);
