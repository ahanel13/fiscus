// SPDX-License-Identifier: AGPL-3.0-or-later
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminInvitesController } from '../admin/admin-invites.controller.js';
import { AdminSettingsController } from '../admin/admin-settings.controller.js';
import { AdminUsersController } from '../admin/admin-users.controller.js';
import { InstanceSettingsService } from '../admin/instance-settings.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AuthCookies } from './cookies.js';
import { CsrfService } from './csrf.service.js';
import { RateLimiter } from './rate-limiter.js';
import { ServerInvitesService } from './server-invites.service.js';
import { SessionService } from './session.service.js';
import { SetupService } from './setup.service.js';
import { SignInService } from './sign-in.service.js';

@Module({
  controllers: [
    AuthController,
    AdminUsersController,
    AdminInvitesController,
    AdminSettingsController,
  ],
  providers: [
    AuditService,
    AuthService,
    AuthCookies,
    CsrfService,
    InstanceSettingsService,
    RateLimiter,
    ServerInvitesService,
    SessionService,
    SetupService,
    SignInService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuditService, InstanceSettingsService, RateLimiter, SessionService, SignInService],
})
export class AuthModule {}
