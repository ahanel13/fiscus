const KEY = 'fiscus.lastHousehold';

export function rememberHousehold(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not critical: we fall back to the first membership.
  }
}

export function lastHousehold(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
