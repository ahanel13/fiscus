// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ChannelTestStatus,
  externalChannelSchema,
  type ExternalChannelKind,
  notificationKindSchema,
  type NotificationKind,
  type NotificationList,
  type NotificationSettingsView,
  setChannelSchemas,
  type SetRule,
  setRuleSchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
} from '../households/household-context.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Your notifications and their settings (#130, bills walkthrough §7; HH-10): every member,
 * viewers included, has their own, and nobody else's.
 */
@Controller('api/v1/households/:householdId/notifications')
@UseGuards(HouseholdGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** The bell: your recent notifications, and how many are unread. */
  @Get()
  async list(@Household() ctx: HouseholdContext): Promise<{ data: NotificationList }> {
    return { data: await this.notifications.list(ctx) };
  }

  @Get('unread-count')
  async unread(@Household() ctx: HouseholdContext): Promise<{ data: { count: number } }> {
    return { data: { count: await this.notifications.unreadCount(ctx) } };
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@Household() ctx: HouseholdContext): Promise<void> {
    await this.notifications.markAllRead(ctx);
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@Household() ctx: HouseholdContext, @Param('id', UuidPipe) id: string): Promise<void> {
    await this.notifications.markRead(ctx, id);
  }

  /** Settings → Notifications: where they go, and what's sent when. */
  @Get('settings')
  async settings(@Household() ctx: HouseholdContext): Promise<{ data: NotificationSettingsView }> {
    return { data: await this.notifications.settings(ctx) };
  }

  @Put('channels/:kind')
  async setChannel(
    @Household() ctx: HouseholdContext,
    @Param('kind', new ZodPipe(externalChannelSchema)) kind: ExternalChannelKind,
    @Body() body: unknown,
  ): Promise<{ data: NotificationSettingsView }> {
    const parsed = new ZodPipe(setChannelSchemas[kind]).transform(body);
    return { data: await this.notifications.setChannel(ctx, kind, parsed) };
  }

  @Delete('channels/:kind')
  async removeChannel(
    @Household() ctx: HouseholdContext,
    @Param('kind', new ZodPipe(externalChannelSchema)) kind: ExternalChannelKind,
  ): Promise<{ data: NotificationSettingsView }> {
    return { data: await this.notifications.removeChannel(ctx, kind) };
  }

  /** Sends a test through a channel; the worker sends it, so ask how it went with its id. */
  @Post('channels/:kind/test')
  @HttpCode(202)
  async test(
    @Household() ctx: HouseholdContext,
    @Param('kind', new ZodPipe(externalChannelSchema)) kind: ExternalChannelKind,
  ): Promise<{ data: { id: string } }> {
    return { data: { id: await this.notifications.testChannel(ctx, kind) } };
  }

  @Get('tests/:id')
  async testStatus(
    @Household() ctx: HouseholdContext,
    @Param('id', UuidPipe) id: string,
  ): Promise<{ data: ChannelTestStatus }> {
    return { data: await this.notifications.testStatus(ctx, id) };
  }

  @Put('rules/:kind')
  async setRule(
    @Household() ctx: HouseholdContext,
    @Param('kind', new ZodPipe(notificationKindSchema)) kind: NotificationKind,
    @Body(new ZodPipe(setRuleSchema)) body: SetRule,
  ): Promise<{ data: NotificationSettingsView }> {
    return { data: await this.notifications.setRule(ctx, kind, body) };
  }
}
