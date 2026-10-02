import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminUsersController } from '../admin/admin-users.controller.js';
import { AuditService } from '../audit/audit.service.js';
import { MeController } from '../me/me.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AuthCookies } from './cookies.js';
import { CsrfService } from './csrf.service.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionService } from './session.service.js';
import { SetupService } from './setup.service.js';

@Module({
  controllers: [AuthController, MeController, AdminUsersController],
  providers: [
    AuditService,
    AuthService,
    AuthCookies,
    CsrfService,
    RateLimiter,
    SessionService,
    SetupService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuditService, SessionService],
})
export class AuthModule {}
