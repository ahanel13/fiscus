export interface HealthStatus {
  status: 'ok' | 'degraded';
  service: 'api' | 'worker' | 'mcp' | 'web';
}

export type CheckStatus = 'ok' | 'failing';

export interface ReadinessStatus extends HealthStatus {
  checks: Record<string, CheckStatus>;
}
