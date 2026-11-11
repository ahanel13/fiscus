// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DbHandle, merchantLogos } from '@fiscus/db';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { FastifyReply } from 'fastify';
import { UuidPipe } from '../common/uuid-pipe.js';
import { problems } from '../common/problem.js';
import { DB } from '../database/database.module.js';

/**
 * A merchant's logo (#423), from Fiscus's own origin, as banks' logos are: the worker fetched it
 * from the provider, so browsers never ask the provider's CDN, the Content-Security-Policy stays
 * `img-src 'self'`, and the provider never learns who looks. Logos are global reference data (no
 * household), and a logo is a public brand mark, so any signed-in person may fetch one by the id
 * a transaction gave them; the id says nothing about who bought what.
 */
@Controller('api/v1/merchant-logos')
export class MerchantLogosController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get(':logoId')
  async logo(
    @Param('logoId', UuidPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const [row] = await this.db.db
      .select({ image: merchantLogos.image, contentType: merchantLogos.contentType })
      .from(merchantLogos)
      .where(eq(merchantLogos.id, id));
    if (!row?.image || !row.contentType) throw problems.notFound();
    void reply
      .header('content-type', row.contentType)
      .header('cache-control', 'private, max-age=604800');
    return row.image;
  }
}
