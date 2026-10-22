// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from 'node:http';
import type { HealthStatus, ReadinessStatus } from '@fiscus/shared';
import type { RunnerStatus } from './runner/runner.js';

/** Readiness, with the runner's loop: when it last passed, and how many jobs are running. */
export interface WorkerReadiness extends ReadinessStatus {
  runner?: Omit<RunnerStatus, 'healthy'>;
}

/** Minimal HTTP server exposing /healthz and /readyz for container orchestration. */
export function startHealthServer(
  port: number,
  isDatabaseReady: () => Promise<boolean>,
  runnerStatus?: () => RunnerStatus,
): Server {
  const server = createServer((req, res) => {
    const send = (status: number, body: HealthStatus | WorkerReadiness) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (req.url === '/healthz') return send(200, { status: 'ok', service: 'worker' });
    if (req.url === '/readyz') {
      void isDatabaseReady().then((database) => {
        const loop = runnerStatus?.();
        const ok = database && (loop?.healthy ?? true);
        send(ok ? 200 : 503, {
          status: ok ? 'ok' : 'degraded',
          service: 'worker',
          checks: {
            database: database ? 'ok' : 'failing',
            ...(loop && { runner: loop.healthy ? 'ok' : 'failing' }),
          },
          ...(loop && { runner: { lastPassAt: loop.lastPassAt, runningJobs: loop.runningJobs } }),
        });
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port);
  return server;
}
