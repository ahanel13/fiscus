// SPDX-License-Identifier: AGPL-3.0-or-later
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
