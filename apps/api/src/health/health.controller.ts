import { Controller, Get } from '@nestjs/common';
import type { HealthStatus } from '@fiscus/shared';

@Controller()
export class HealthController {
  @Get('healthz')
  healthz(): HealthStatus {
    return { status: 'ok', service: 'api' };
  }
}
