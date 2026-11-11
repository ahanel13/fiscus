// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fetchLogo, imageType, LOGO_MAX_BYTES, logoUrlAllowed } from './merchant-logos.js';

/** Merchants' logos (#423): only Plaid's logo hosts, only small images of known types. */
describe('merchant logos', () => {
  it('fetches only from Plaid’s logo hosts, over https', () => {
    for (const ok of [
      'https://plaid-merchant-logos.plaid.com/corner_coffee.png',
      'https://plaid-counterparty-logos.plaid.com/x.png',
    ])
      expect([ok, logoUrlAllowed(ok)]).toEqual([ok, true]);
    for (const bad of [
      'http://plaid-merchant-logos.plaid.com/a.png',
      'https://plaid-merchant-logos.plaid.com:8443/a.png',
      'https://user@plaid-merchant-logos.plaid.com/a.png',
      'https://plaid-merchant-logos.plaid.com.evil.example/a.png',
      'https://evil.example/plaid-merchant-logos.plaid.com.png',
      'https://cdn.plaid.com/a.png',
      'https://127.0.0.1/a.png',
      'not a url',
    ])
      expect([bad, logoUrlAllowed(bad)]).toEqual([bad, false]);
  });

  it('knows PNG, JPEG and WebP by their first bytes, and nothing else', () => {
    const b = (hex: string) => Buffer.from(hex, 'hex');
    expect(imageType(b('89504e470d0a1a0a00'))).toBe('image/png');
    expect(imageType(b('ffd8ffe000'))).toBe('image/jpeg');
    expect(imageType(b('524946460000000057454250'))).toBe('image/webp');
    expect(imageType(b('3c737667'))).toBeNull(); // <svg: scripts can hide in SVG
    expect(imageType(b('47494638'))).toBeNull();
  });

  it('refuses what isn’t a small known image, or doesn’t answer', async () => {
    const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
    const url = 'https://plaid-merchant-logos.plaid.com/a.png';
    const answer = (body: Buffer, status = 200) =>
      (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await fetchLogo(url, answer(PNG))).toEqual({ image: PNG, contentType: 'image/png' });
    expect(await fetchLogo(url, answer(PNG, 404))).toBeNull();
    expect(await fetchLogo(url, answer(Buffer.from('<svg/>')))).toBeNull();
    expect(
      await fetchLogo(url, answer(Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)]))),
    ).toBeNull();
    let asked = false;
    const spy = (async () => {
      asked = true;
      return new Response(PNG);
    }) as unknown as typeof fetch;
    expect(await fetchLogo('https://evil.example/a.png', spy)).toBeNull();
    expect(asked).toBe(false);
  });
});
