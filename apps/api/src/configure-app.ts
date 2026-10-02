import fastifyCookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Server setup shared by main.ts and integration tests. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyCookie);
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });
}
