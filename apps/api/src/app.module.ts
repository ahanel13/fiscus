import { type DynamicModule, Module } from '@nestjs/common';
import { type CryptoConfig, CryptoModule } from './crypto/crypto.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';

export interface AppConfig extends CryptoConfig {
  databaseUrl: string;
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.forRoot(config.databaseUrl), CryptoModule.forRoot(config)],
      controllers: [HealthController],
    };
  }
}
