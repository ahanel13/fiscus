import { type DbHandle, pingDatabase } from '@fiscus/db';
import type { HealthStatus, ReadinessStatus } from '@fiscus/shared';
import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { DB } from '../database/database.module.js';

@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** Liveness: the process is up. Never checks dependencies. */
  @Get('healthz')
  healthz(): HealthStatus {
    return { status: 'ok', service: 'api' };
  }

  /** Readiness: dependencies are reachable, so the instance can take traffic. */
  @Get('readyz')
  async readyz(): Promise<ReadinessStatus> {
    const database = (await pingDatabase(this.db.pool)) ? 'ok' : 'failing';
    const body: ReadinessStatus = {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'api',
      checks: { database },
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}
