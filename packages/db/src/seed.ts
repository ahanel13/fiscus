#!/usr/bin/env node
import { loadEnvOrExit } from '@fiscus/env';
import { createDb } from './client.js';
import migrateEnv from './env.js';

// Development seed data. It must stay obviously fake (no real names, institutions, or amounts
// copied from real statements). Each feature adds its fixtures here; households arrive in #17.
const env = loadEnvOrExit(migrateEnv);
const { db, close } = createDb(env.DATABASE_URL, { max: 1 });

try {
  await db.transaction(async () => {
    console.log('[seed] Nothing to seed yet.');
  });
} finally {
  await close();
}
