// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { envKeyProvider, masterKeysOrExit } from '@fiscus/crypto';
import { createDb, pingDatabase } from '@fiscus/db';
import { exitOnUnhandled, loadEnvOrExit, toNestLogLevels } from '@fiscus/env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import workerEnv from './env.js';
import { startHealthServer } from './health-server.js';
import { WorkerModule } from './worker.module.js';

const env = loadEnvOrExit(workerEnv);
// Without values: Node's own report prints the whole error (#308).
exitOnUnhandled((message) => new Logger('Process').fatal(message));
// Fail at startup, not at the first job, if the key is unusable. Jobs that decrypt use it in M2+.
await masterKeysOrExit(envKeyProvider(env), (message) => new Logger('Keys').fatal(message));
const db = createDb(env.DATABASE_URL, { max: 5 });

const app = await NestFactory.createApplicationContext(WorkerModule, {
  logger: toNestLogLevels(env.LOG_LEVEL),
});
const health = startHealthServer(env.HEALTH_PORT, () => pingDatabase(db.pool));
const logger = new Logger('Worker');
logger.log(`Worker ready (health on :${env.HEALTH_PORT})`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.log(`${signal} received, shutting down`);
    health.close();
    void Promise.allSettled([app.close(), db.close()]).then(() => process.exit(0));
  });
}
