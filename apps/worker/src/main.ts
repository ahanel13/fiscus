import 'reflect-metadata';
import { loadEnvOrExit, toNestLogLevels } from '@fiscus/env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import workerEnv from './env.js';
import { WorkerModule } from './worker.module.js';

const env = loadEnvOrExit(workerEnv);

const app = await NestFactory.createApplicationContext(WorkerModule, {
  logger: toNestLogLevels(env.LOG_LEVEL),
});
app.enableShutdownHooks();
new Logger('Worker').log('Worker ready');

// Keeps the process alive until job queues (and the health port in #8) do.
setInterval(() => {}, 2 ** 30);
