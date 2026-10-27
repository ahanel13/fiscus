// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BankLogo, textOn } from './BankLogo.js';

describe('BankLogo', () => {
  it('shows the logo from Fiscus’s own origin, never the provider’s', () => {
    const { container } = render(
      <BankLogo
        institution={{ id: 'ins-1', name: 'Harbor Credit Union', color: '#1f5f8b', hasLogo: true }}
        name="Everyday checking"
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      '/api/v1/institutions/ins-1/logo',
    );
  });

  it('falls back to the bank’s initials on its color, or the account’s on a neutral one', () => {
    const bank = render(
      <BankLogo
        institution={{ id: 'ins-2', name: 'Summit Card', color: '#7a3e9d', hasLogo: false }}
        name="Card"
      />,
    ).container.firstElementChild as HTMLElement;
    expect(bank.textContent).toBe('SC');
    expect(bank.getAttribute('style')).toMatch(/#7a3e9d|rgb\(122, 62, 157\)/i);
    const manual = render(<BankLogo institution={null} name="Holiday fund" />).container
      .firstElementChild as HTMLElement;
    expect(manual.textContent).toBe('HF');
    expect(manual.getAttribute('style')).toBeNull();
  });

  it('picks text that reads on the bank’s color', () => {
    expect(textOn('#1f5f8b')).toBe('#ffffff');
    expect(textOn('#ffd200')).toBe('#000000');
    expect(textOn('#000000')).toBe('#ffffff');
    expect(textOn('#ffffff')).toBe('#000000');
  });
});
