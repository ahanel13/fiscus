// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DbHandle, pingDatabase } from '@fiscus/db';
import type { HealthStatus, ReadinessStatus } from '@fiscus/shared';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { NoSession } from '../auth/decorators.js';
import { DB } from '../database/database.module.js';

@NoSession()
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
  async readyz(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessStatus> {
    const database = (await pingDatabase(this.db.pool)) ? 'ok' : 'failing';
    const body: ReadinessStatus = {
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'api',
      checks: { database },
    };
    // A probe result, not an error: keep the readiness body rather than a problem document.
    if (body.status !== 'ok') void reply.status(503);
    return body;
  }
}
