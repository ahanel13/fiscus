// Applies the theme before first paint to avoid a flash (see src/lib/theme.ts). A file, not an
// inline script, so the Content-Security-Policy can allow scripts from this origin only (#378).
try {
  var t = localStorage.getItem('fiscus.theme');
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
  if (localStorage.getItem('fiscus.density') === 'compact')
    document.documentElement.dataset.density = 'compact';
} catch {
  // No storage (a private window, blocked site data): the default theme.
}
