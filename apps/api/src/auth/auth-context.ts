import type { CurrentUser } from '@fiscus/shared';

export interface AuthContext {
  session: { id: string; expiresAt: Date; reauthenticatedAt: Date };
  user: CurrentUser;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext | null;
  }
}
