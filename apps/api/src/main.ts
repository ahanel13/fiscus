// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { masterKeysOrExit } from '@fiscus/crypto';
import { exitOnUnhandled, loadEnvOrExit, toNestLogLevels } from '@fiscus/env';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { configureApp } from './configure-app.js';
import { masterKeysFrom } from './crypto/crypto.module.js';
import apiEnv from './env.js';

const env = loadEnvOrExit(apiEnv);
// Without values: Node's own report prints the whole error (#308).
exitOnUnhandled((message) => new Logger('Process').fatal(message));

const config: AppConfig = {
  databaseUrl: env.DATABASE_URL,
  encryptionKey: env.APP_ENCRYPTION_KEY,
  encryptionKeyVersion: env.APP_ENCRYPTION_KEY_VERSION,
  encryptionKeyPrevious: env.APP_ENCRYPTION_KEY_PREVIOUS,
  encryptionKeyPreviousVersion: env.APP_ENCRYPTION_KEY_PREVIOUS_VERSION,
  publicUrl: env.PUBLIC_URL,
  signupMode: env.SIGNUP_MODE,
  cookieSecure: env.COOKIE_SECURE,
};
// Fail closed, and say why: keys that can't work stop the api before it serves anything (#307).
await masterKeysOrExit({ masterKeys: () => masterKeysFrom(config) }, (message) =>
  new Logger('Keys').fatal(message),
);

const app = await NestFactory.create<NestFastifyApplication>(
  AppModule.register(config),
  new FastifyAdapter({ trustProxy: env.TRUST_PROXY }),
  { logger: toNestLogLevels(env.LOG_LEVEL) },
);
await configureApp(app);
app.enableShutdownHooks();
await app.listen({ port: env.PORT, host: env.HOST });
