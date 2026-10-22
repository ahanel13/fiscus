// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { typing } from './shortcuts.js';

const input = (type: string) => Object.assign(document.createElement('input'), { type });

describe('typing', () => {
  it('is true in fields people type in, and false on a checkbox, radio or button', () => {
    for (const el of [
      input('text'),
      input('search'),
      document.createElement('textarea'),
      document.createElement('select'),
    ]) {
      expect(typing(el)).toBe(true);
    }
    for (const el of [input('checkbox'), input('radio'), document.createElement('button')]) {
      expect(typing(el)).toBe(false);
    }
    expect(typing(document.body)).toBe(false);
  });
});
