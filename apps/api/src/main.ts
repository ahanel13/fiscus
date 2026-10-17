// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { exitOnUnhandled, loadEnvOrExit, toNestLogLevels } from '@fiscus/env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { configureApp } from './configure-app.js';
import apiEnv from './env.js';

const env = loadEnvOrExit(apiEnv);
// Without values: Node's own report prints the whole error (#308).
exitOnUnhandled((message) => new Logger('Process').fatal(message));

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register({
    databaseUrl: env.DATABASE_URL,
    encryptionKey: env.APP_ENCRYPTION_KEY,
    encryptionKeyVersion: env.APP_ENCRYPTION_KEY_VERSION,
    publicUrl: env.PUBLIC_URL,
    signupMode: env.SIGNUP_MODE,
    cookieSecure: env.COOKIE_SECURE,
  }),
  new FastifyAdapter({ trustProxy: env.TRUST_PROXY }),
  { logger: toNestLogLevels(env.LOG_LEVEL) },
);
await configureApp(app);
app.enableShutdownHooks();
await app.listen({ port: env.PORT, host: env.HOST });
