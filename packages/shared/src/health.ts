export interface HealthStatus {
  status: 'ok' | 'degraded';
  service: 'api' | 'worker' | 'mcp' | 'web';
}
