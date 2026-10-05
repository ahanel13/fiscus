declare global {
  interface Window {
    __FISCUS_CONFIG__?: { apiUrl?: string };
  }
}

/** Runtime config written by the container at startup (/env.js, ADR 0003). */
export const apiBase = (): string => (window.__FISCUS_CONFIG__?.apiUrl ?? '').replace(/\/$/, '');
