import 'reflect-metadata';
import { loadEnvOrExit, toNestLogLevels } from '@fiscus/env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import apiEnv from './env.js';

const env = loadEnvOrExit(apiEnv);

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register({ databaseUrl: env.DATABASE_URL }),
  new FastifyAdapter(),
  { logger: toNestLogLevels(env.LOG_LEVEL) },
);
app.enableShutdownHooks();
await app.listen({ port: env.PORT, host: env.HOST });
