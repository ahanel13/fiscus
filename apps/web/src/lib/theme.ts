// SPDX-License-Identifier: AGPL-3.0-or-later
export type ThemePreference = 'light' | 'dark' | 'system';
const KEY = 'fiscus.theme';

export function storedTheme(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): 'light' | 'dark' {
  return pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
}

/** Applies the theme to <html> and remembers the choice on this device. */
export function applyTheme(pref: ThemePreference): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage unavailable (private mode): still apply for this session.
  }
  const dark =
    resolveTheme(pref, window.matchMedia('(prefers-color-scheme: dark)').matches) === 'dark';
  document.documentElement.classList.toggle('dark', dark);
}
