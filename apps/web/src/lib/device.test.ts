// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { describeDevice } from './device.js';

describe('describeDevice', () => {
  it('names the browser and system', () => {
    expect(
      describeDevice('Mozilla/5.0 (Android 16; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0'),
    ).toBe('Firefox on Android');
    expect(
      describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0'),
    ).toBe('Firefox on Linux');
    expect(
      describeDevice(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('Safari on iOS');
    expect(
      describeDevice(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36 Edg/150.0',
      ),
    ).toBe('Edge on Windows');
    expect(
      describeDevice(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36',
      ),
    ).toBe('Chrome on macOS');
  });

  it('falls back without guessing', () => {
    expect(describeDevice(null)).toBe('Unknown device');
    expect(describeDevice('curl/8.5.0')).toBe('curl');
    expect(describeDevice('SomethingElse')).toBe('Browser');
  });
});
