import { randomBytes } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import type { AppConfig } from '../config.js';
import { configureApp } from '../configure-app.js';

export async function createTestApp(
  databaseUrl: string,
  overrides: Partial<AppConfig> = {},
): Promise<NestFastifyApplication> {
  const config: AppConfig = {
    databaseUrl,
    encryptionKey: randomBytes(32).toString('base64'),
    encryptionKeyVersion: 1,
    publicUrl: 'https://fiscus.test',
    signupMode: 'invite_only',
    cookieSecure: true,
    ...overrides,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A browser-like client: keeps cookies, fetches and sends CSRF tokens on unsafe requests. */
export class TestClient {
  readonly cookies = new Map<string, string>();
  csrfToken: string | undefined;

  constructor(private readonly app: NestFastifyApplication) {}

  async request(method: Method, url: string, body?: unknown, { csrf = true } = {}) {
    if (method !== 'GET' && csrf && !this.csrfToken) {
      await this.request('GET', '/api/v1/auth/csrf');
    }
    const res = await this.app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookies.size
          ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
          : {}),
        ...(method !== 'GET' && csrf && this.csrfToken ? { 'x-csrf-token': this.csrfToken } : {}),
      },
    });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const json = res.body ? safeJson(res.body) : undefined;
    const token = (json as { data?: { csrfToken?: string } } | undefined)?.data?.csrfToken;
    if (token) this.csrfToken = token;
    return { status: res.statusCode, headers: res.headers, body: json as any, raw: res };
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: unknown, opts?: { csrf?: boolean }) =>
    this.request('POST', url, body ?? {}, opts);
  delete = (url: string) => this.request('DELETE', url);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
