// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for a provider's api in adapter tests (D17: nothing in the test suite touches a real
// bank): a Node http server on an ephemeral local port that answers from route handlers and
// records every request.

export interface StubRequest {
  method: string;
  /** Without the query string. */
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface StubResponse {
  /** Defaults to 200. */
  status?: number;
  headers?: Record<string, string>;
  /** A string is sent as is; anything else as JSON. */
  body?: unknown;
}

export type StubHandler = (request: StubRequest) => StubResponse | Promise<StubResponse>;

/** Keyed by `METHOD /path`, e.g. `POST /transactions/sync`. */
export type StubRoutes = Record<string, StubHandler>;

export interface StubServer {
  /** `http://127.0.0.1:<port>` (or the host it listens on), without a trailing slash. */
  url: string;
  /** Every request received, in order, including ones no route matched. */
  requests: StubRequest[];
  /** Adds or replaces a route's handler. */
  route(key: string, handler: StubHandler): void;
  close(): Promise<void>;
}

/** Parses a recorded request's body as JSON. */
export const jsonBody = <T = unknown>(request: StubRequest): T => JSON.parse(request.body) as T;

/** Where the server listens: an ephemeral port on loopback unless told otherwise (a service). */
export interface StubListen {
  host?: string;
  port?: number;
}

export async function startStubServer(
  routes: StubRoutes = {},
  { host = '127.0.0.1', port = 0 }: StubListen = {},
): Promise<StubServer> {
  const handlers = new Map(Object.entries(routes));
  const requests: StubRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      const request: StubRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      const handler = handlers.get(`${request.method} ${request.path}`);
      Promise.resolve()
        .then(() =>
          handler ? handler(request) : { status: 404, body: { error: 'no stub route' } },
        )
        .then(
          (response) => {
            const text =
              typeof response.body === 'string'
                ? response.body
                : response.body === undefined
                  ? ''
                  : JSON.stringify(response.body);
            const headers: Record<string, string> = {
              ...(typeof response.body !== 'string' &&
                response.body !== undefined && { 'content-type': 'application/json' }),
              ...response.headers,
            };
            res.writeHead(response.status ?? 200, headers).end(text);
          },
          (error: unknown) => {
            res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
          },
        );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`,
    requests,
    route(key, handler) {
      handlers.set(key, handler);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
