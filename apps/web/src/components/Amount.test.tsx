import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Amount } from './Amount.js';

describe('Amount', () => {
  it('shows money in as green with a plus sign and an accessible label', () => {
    render(<Amount minor={241000} currency="USD" />);
    const el = screen.getByLabelText('Received $2,410.00');
    expect(el).toHaveTextContent('+$2,410.00');
    expect(el).toHaveClass('text-positive');
  });

  it('shows money out as plain text with a true minus sign, not red', () => {
    render(<Amount minor={-8412} currency="USD" />);
    const el = screen.getByLabelText('Spent $84.12');
    expect(el).toHaveTextContent('−$84.12');
    expect(el.className).not.toMatch(/danger|positive/);
  });

  it('shows a negative balance in red', () => {
    render(<Amount minor={-12000} currency="USD" kind="balance" />);
    expect(screen.getByText('−$120.00')).toHaveClass('text-danger');
  });

  it('uses tabular figures', () => {
    render(<Amount minor={100} currency="JPY" kind="balance" />);
    expect(screen.getByText('¥100')).toHaveClass('amount');
  });
});
