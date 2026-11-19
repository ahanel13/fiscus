// SPDX-License-Identifier: AGPL-3.0-or-later
import { Readable } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import { PLAID_WEBHOOK_BODY_LIMIT, PLAID_WEBHOOK_PATH } from '@fiscus/aggregation';
import { IMPORT_LIMITS } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest, preParsingHookHandler } from 'fastify';

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The body's exact bytes, kept for the Plaid webhook route only (#84): its JWT signs them. */
    rawBody?: Buffer;
  }
  interface FastifyInstance {
    /** Every route the app registers; the generated cross-tenant tests iterate over it. */
    fiscusRoutes: RegisteredRoute[];
  }
}

/** Server setup shared by main.ts and integration tests. Must run before app.init(). */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyCookie);
  const fastify = app.getHttpAdapter().getInstance();
  fastify.decorate('fiscusRoutes', []);
  fastify.addHook('onRoute', (route) => {
    // Import previews send a whole file's rows, and row parts can carry years of daily
    // balances; every other route keeps the 1 MB default.
    if (/\/imports\/(preview|:batchId\/rows)$/.test(route.url)) {
      route.bodyLimit = IMPORT_LIMITS.bodyBytes;
    }
    // Plaid's webhooks (#84): small bodies only, and their exact bytes, which the JWT's hash is of.
    if (route.url === PLAID_WEBHOOK_PATH) {
      route.bodyLimit = PLAID_WEBHOOK_BODY_LIMIT;
      route.preParsing = [...[route.preParsing ?? []].flat(), keepRawBody];
    }
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') fastify.fiscusRoutes.push({ method, url: route.url });
    }
  });
  fastify.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
}

const tooLarge = () =>
  Object.assign(new Error('Request body is too large'), {
    statusCode: 413,
    code: 'FST_ERR_CTP_BODY_TOO_LARGE',
  });

/**
 * Reads the body (up to the webhook limit, refusing more as it arrives), keeps its bytes on the
 * request, and hands the same bytes on to the JSON parser.
 */
const keepRawBody: preParsingHookHandler = async (req: FastifyRequest, _reply, payload) => {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > PLAID_WEBHOOK_BODY_LIMIT) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > PLAID_WEBHOOK_BODY_LIMIT) throw tooLarge();
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  req.rawBody = raw;
  const again = Readable.from(raw.length ? [raw] : [], { objectMode: false }) as Readable & {
    receivedEncodedLength?: number;
  };
  again.receivedEncodedLength = raw.length;
  return again;
};
