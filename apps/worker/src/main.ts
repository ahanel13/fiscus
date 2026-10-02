import 'reflect-metadata';
import { createDb, pingDatabase } from '@fiscus/db';
import { loadEnvOrExit, toNestLogLevels } from '@fiscus/env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import workerEnv from './env.js';
import { startHealthServer } from './health-server.js';
import { WorkerModule } from './worker.module.js';

const env = loadEnvOrExit(workerEnv);
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
