// SPDX-License-Identifier: AGPL-3.0-or-later
// Applies the theme before first paint to avoid a flash (see src/lib/theme.ts). A file, not an
// inline script, so the Content-Security-Policy can allow scripts from this origin only (#378).
try {
  var t = localStorage.getItem('fiscus.theme');
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
  // The phone's status bar, when installed as an app: the page's background (--bg).
  if (dark) document.querySelector('meta[name="theme-color"]').content = '#121212';
  if (localStorage.getItem('fiscus.density') === 'compact')
    document.documentElement.dataset.density = 'compact';
} catch {
  // No storage (a private window, blocked site data): the default theme.
}
