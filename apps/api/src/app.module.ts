import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule.forRoot(config.databaseUrl),
        CryptoModule.forRoot(config),
        AuthModule,
      ],
      controllers: [HealthController],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}
