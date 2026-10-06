// SPDX-License-Identifier: AGPL-3.0-or-later
import fastifyCookie from '@fastify/cookie';
import { IMPORT_LIMITS } from '@fiscus/shared';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export interface RegisteredRoute {
  method: string;
  url: string;
}

declare module 'fastify' {
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
    // Imports send a whole file's rows at once; every other route keeps the 1 MB default.
    if (/\/imports(\/preview)?$/.test(route.url) && [route.method].flat().includes('POST')) {
      route.bodyLimit = IMPORT_LIMITS.bodyBytes;
    }
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') fastify.fiscusRoutes.push({ method, url: route.url });
    }
  });
  fastify.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
}
