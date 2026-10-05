// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import type { HealthStatus, ReadinessStatus } from '@fiscus/shared';

/** Minimal HTTP server exposing /healthz and /readyz for container orchestration. */
export function startHealthServer(port: number, isDatabaseReady: () => Promise<boolean>): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: HealthStatus | ReadinessStatus) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (req.url === '/healthz') return send(200, { status: 'ok', service: 'worker' });
    if (req.url === '/readyz') {
      void isDatabaseReady().then((ok) =>
        send(ok ? 200 : 503, {
          status: ok ? 'ok' : 'degraded',
          service: 'worker',
          checks: { database: ok ? 'ok' : 'failing' },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
