export type Density = 'comfortable' | 'compact';
const KEY = 'fiscus.density';

export function storedDensity(): Density {
  try {
    return localStorage.getItem(KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/** Comfortable by default; compact tightens lists and tables (tokens.css --row-h). */
export function applyDensity(density: Density): void {
  try {
    if (density === 'compact') localStorage.setItem(KEY, density);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: apply for this session only.
  }
  if (density === 'compact') document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
}
