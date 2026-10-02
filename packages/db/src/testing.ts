import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runMigrations } from './migrate.js';

export interface TestDatabase {
  /** Connects as the schema owner (bypasses nothing RLS-wise, but owns the tables). */
  ownerUrl: string;
  /** Connects as fiscus_app, the role services use. */
  appUrl: string;
  /** Connects as fiscus_maintenance (BYPASSRLS). */
  maintenanceUrl: string;
  stop(): Promise<void>;
}

const APP_PASSWORD = 'test-app-password';
const MAINTENANCE_PASSWORD = 'test-maintenance-password';

/** Starts a throwaway Postgres 17 with all migrations applied. Requires Docker. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('fiscus')
    .withUsername('fiscus_owner')
    .withPassword('test-owner-password')
    .start();

  const ownerUrl = container.getConnectionUri();
  await runMigrations(ownerUrl, {
    appPassword: APP_PASSWORD,
    maintenancePassword: MAINTENANCE_PASSWORD,
  });

  const withRole = (user: string, password: string) => {
    const url = new URL(ownerUrl);
    url.username = user;
    url.password = password;
    return url.toString();
  };

  return {
    ownerUrl,
    appUrl: withRole('fiscus_app', APP_PASSWORD),
    maintenanceUrl: withRole('fiscus_maintenance', MAINTENANCE_PASSWORD),
    stop: async () => {
      await container.stop();
    },
  };
}
