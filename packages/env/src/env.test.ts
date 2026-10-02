import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { logLevel, port, toNestLogLevels } from './common.js';
import { defineEnv, EnvError, loadEnv, redactEnv } from './env.js';

const def = defineEnv('test', {
  PORT: port(3000),
  LOG_LEVEL: logLevel,
  DATABASE_URL: { schema: z.url(), description: 'Postgres URL', secret: true },
  API_TOKEN: { schema: z.string().min(8), description: 'Token', secret: true },
});

const valid = { DATABASE_URL: 'postgres://u:p@db/fiscus', API_TOKEN: 's3cr3t-token' };
const files = (map: Record<string, string>) => (path: string) => {
  const v = map[path];
  if (v === undefined) throw new Error('ENOENT');
  return v;
};

describe('loadEnv', () => {
  it('parses values, coerces numbers, and applies defaults', () => {
    const env = loadEnv(def, { source: { ...valid, PORT: '8080' } });
    expect(env).toEqual({ ...valid, PORT: 8080, LOG_LEVEL: 'info' });
  });

  it('treats empty strings as unset', () => {
    expect(loadEnv(def, { source: { ...valid, PORT: '' } }).PORT).toBe(3000);
  });

  it('reports every problem at once', () => {
    const run = () => loadEnv(def, { source: { PORT: 'abc', LOG_LEVEL: 'loud' } });
    expect(run).toThrow(EnvError);
    try {
      run();
    } catch (err) {
      const names = (err as EnvError).problems.map((p) => p.split(':')[0]);
      expect(names.sort()).toEqual(['API_TOKEN', 'DATABASE_URL', 'LOG_LEVEL', 'PORT']);
    }
  });

  it('never includes values in error messages', () => {
    const source = { DATABASE_URL: 'not-a-url-but-secret', API_TOKEN: 'short' };
    try {
      loadEnv(def, { source });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('not-a-url-but-secret');
      expect((err as Error).message).not.toContain('short');
    }
  });

  describe('NAME_FILE', () => {
    it('reads the value from a file and strips one trailing newline', () => {
      const env = loadEnv(def, {
        source: { DATABASE_URL: valid.DATABASE_URL, API_TOKEN_FILE: '/run/secrets/token' },
        readFile: files({ '/run/secrets/token': 'from-file-token\n' }),
      });
      expect(env.API_TOKEN).toBe('from-file-token');
    });

    it('rejects setting both NAME and NAME_FILE', () => {
      expect(() =>
        loadEnv(def, {
          source: { ...valid, API_TOKEN_FILE: '/x' },
          readFile: files({ '/x': 'y' }),
        }),
      ).toThrow(/API_TOKEN: set either API_TOKEN or API_TOKEN_FILE/);
    });

    it('reports unreadable files', () => {
      expect(() =>
        loadEnv(def, {
          source: { DATABASE_URL: valid.DATABASE_URL, API_TOKEN_FILE: '/missing' },
          readFile: files({}),
        }),
      ).toThrow(/API_TOKEN_FILE: cannot read \/missing/);
    });
  });
});

describe('redactEnv', () => {
  it('replaces secret values only', () => {
    const env = loadEnv(def, { source: valid });
    expect(redactEnv(def, env)).toEqual({
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_URL: '[redacted]',
      API_TOKEN: '[redacted]',
    });
  });
});

describe('toNestLogLevels', () => {
  it('includes the chosen level and everything more severe', () => {
    expect(toNestLogLevels('warn')).toEqual(['fatal', 'error', 'warn']);
    expect(toNestLogLevels('info')).toEqual(['fatal', 'error', 'warn', 'log']);
    expect(toNestLogLevels('trace')).toHaveLength(6);
  });
});
