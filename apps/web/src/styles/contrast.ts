// SPDX-License-Identifier: AGPL-3.0-or-later
/** Expands #rgb to #rrggbb (minifiers shorten colors in built CSS). */
const normalize = (hex: string) =>
  /^#[0-9a-f]{3}$/i.test(hex) ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;

/** WCAG 2.x relative luminance and contrast ratio for #rgb / #rrggbb colors. */
export function contrast(a: string, b: string): number {
  const lum = (input: string) => {
    const hex = normalize(input);
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
