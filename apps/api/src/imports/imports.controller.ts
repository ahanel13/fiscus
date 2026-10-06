// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createImportProfileSchema,
  type ImportBatch,
  type ImportPreview,
  type ImportProfile,
  importRequestSchema,
  type ImportResult,
  updateImportProfileSchema,
} from '@fiscus/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { z } from 'zod';
import { UuidPipe } from '../common/uuid-pipe.js';
import { ZodPipe } from '../common/zod-pipe.js';
import {
  Household,
  type HouseholdContext,
  HouseholdGuard,
  HouseholdRoles,
} from '../households/household-context.js';
import { ImportsService } from './imports.service.js';

type ImportBody = z.output<typeof importRequestSchema>;

/**
 * File imports (docs/design/imports.md): preview, import, list, and undo (TXN-09/10). Bodies
 * here may be up to 25 MB (configure-app.ts); everywhere else keeps Fastify's 1 MB.
 */
@Controller('api/v1/households/:householdId')
@UseGuards(HouseholdGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('imports')
  async list(@Household() ctx: HouseholdContext): Promise<{ data: ImportBatch[] }> {
    return { data: await this.imports.list(ctx) };
  }

  /** A dry run: everything the import would do, with nothing saved. */
  @Post('imports/preview')
  @HouseholdRoles('owner', 'member')
  @HttpCode(200)
  async preview(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(importRequestSchema)) body: ImportBody,
  ): Promise<{ data: ImportPreview }> {
    return { data: await this.imports.preview(ctx, body) };
  }

  @Post('imports')
  @HouseholdRoles('owner', 'member')
  async commit(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(importRequestSchema)) body: ImportBody,
  ): Promise<{ data: ImportResult }> {
    return { data: await this.imports.commit(ctx, body) };
  }

  @Post('imports/:batchId/revert')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async revert(
    @Household() ctx: HouseholdContext,
    @Param('batchId', UuidPipe) batchId: string,
  ): Promise<void> {
    await this.imports.revert(ctx, batchId);
  }

  @Get('import-profiles')
  async listProfiles(@Household() ctx: HouseholdContext): Promise<{ data: ImportProfile[] }> {
    return { data: await this.imports.listProfiles(ctx) };
  }

  @Post('import-profiles')
  @HouseholdRoles('owner', 'member')
  async createProfile(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(createImportProfileSchema)) body: z.infer<typeof createImportProfileSchema>,
  ): Promise<{ data: ImportProfile }> {
    return { data: await this.imports.createProfile(ctx, body) };
  }

  @Patch('import-profiles/:profileId')
  @HouseholdRoles('owner', 'member')
  async updateProfile(
    @Household() ctx: HouseholdContext,
    @Param('profileId', UuidPipe) id: string,
    @Body(new ZodPipe(updateImportProfileSchema)) body: z.infer<typeof updateImportProfileSchema>,
  ): Promise<{ data: ImportProfile }> {
    return { data: await this.imports.updateProfile(ctx, id, body) };
  }

  @Delete('import-profiles/:profileId')
  @HouseholdRoles('owner', 'member')
  @HttpCode(204)
  async deleteProfile(
    @Household() ctx: HouseholdContext,
    @Param('profileId', UuidPipe) id: string,
  ): Promise<void> {
    await this.imports.deleteProfile(ctx, id);
  }
}
