import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from 'react-aria-components';
import { describe, expect, it, vi } from 'vitest';
import { AmountInput } from './amount-input.js';

async function typeAmount(
  text: string,
  props: Partial<Parameters<typeof AmountInput>[0]> = {},
  locale = 'en-US',
) {
  const onChange = vi.fn();
  render(
    <I18nProvider locale={locale}>
      <form aria-label="f">
        <AmountInput label="Amount" currency="USD" name="amount" onChange={onChange} {...props} />
      </form>
    </I18nProvider>,
  );
  const input = screen.getByLabelText('Amount');
  await userEvent.type(input, text);
  await userEvent.tab(); // values commit on blur
  return { onChange, input };
}

const hidden = () => document.querySelector<HTMLInputElement>('input[type=hidden][name=amount]')!;

describe('AmountInput', () => {
  it('turns what people type into integer cents', async () => {
    const { onChange, input } = await typeAmount('1,234.56');
    expect(onChange).toHaveBeenLastCalledWith(123456);
    expect(input).toHaveValue('$1,234.56');
    expect(hidden().value).toBe('123456');
  });

  it("parses the viewer's format", async () => {
    const { onChange } = await typeAmount('1.234,56', {}, 'de-DE');
    expect(onChange).toHaveBeenLastCalledWith(123456);
  });

  it('uses the currency exponent', async () => {
    const { onChange } = await typeAmount('1500', { currency: 'JPY' });
    expect(onChange).toHaveBeenLastCalledWith(1500);
  });

  it('rounds extra decimals to the currency', async () => {
    const { onChange } = await typeAmount('10.129');
    expect(onChange).toHaveBeenLastCalledWith(1013);
  });

  it('reports an empty field as null', async () => {
    const onChange = vi.fn();
    render(
      <AmountInput
        label="Amount"
        currency="USD"
        name="amount"
        defaultValue={500}
        onChange={onChange}
      />,
    );
    await userEvent.clear(screen.getByLabelText('Amount'));
    await userEvent.tab();
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(hidden().value).toBe('');
  });

  it('shows a controlled value in minor units', () => {
    render(<AmountInput label="Amount" currency="KWD" value={12345} />);
    expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toMatch(/^KWD\s12\.345$/);
  });

  it("doesn't accept a minus sign unless negatives are allowed", async () => {
    const { onChange } = await typeAmount('-25');
    expect(onChange).toHaveBeenLastCalledWith(2500);
  });

  it('accepts negatives when allowed', async () => {
    const { onChange } = await typeAmount('-25', { allowNegative: true });
    expect(onChange).toHaveBeenLastCalledWith(-2500);
  });
});
