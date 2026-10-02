import { type DynamicModule, Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';

export interface AppConfig {
  databaseUrl: string;
}

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.forRoot(config.databaseUrl)],
      controllers: [HealthController],
    };
  }
}
