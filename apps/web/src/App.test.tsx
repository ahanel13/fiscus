import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App', () => {
  it('renders an amount formatted by @fiscus/shared', () => {
    expect(renderToString(<App />)).toContain('-$45.80');
  });
});
