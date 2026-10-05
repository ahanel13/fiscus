import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button.js';
import { Avatar, initials } from './display.js';
import { Form, TextField } from './field.js';
import { ConfirmDialog, Dialog, DialogTrigger, Menu, MenuItem, MenuTrigger } from './overlays.js';
import { Select, SelectItem } from './select.js';
import { Cell, Column, Row, Table, TableBody, TableHeader } from './table.js';
import { toast, Toaster, toastQueue } from './toast.js';
import { SegmentedControl, Switch } from './toggles.js';

describe('Button', () => {
  it('fires onPress, and not while pending', async () => {
    const onPress = vi.fn();
    const { rerender } = render(<Button onPress={onPress}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onPress).toHaveBeenCalledTimes(1);

    rerender(
      <Button onPress={onPress} isPending>
        Save
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('Form and TextField', () => {
  it('shows server errors on the field and clears them when edited', async () => {
    render(
      <Form validationErrors={{ email: 'That email is already in use.' }}>
        <TextField label="Email" name="email" />
      </Form>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('That email is already in use.')).toBeInTheDocument();
    await userEvent.type(input, 'a');
    await userEvent.tab();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('links the description to the input', () => {
    render(<TextField label="Password" description="At least 12 characters." />);
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(
      'At least 12 characters.',
    );
  });
});

describe('Select', () => {
  it('chooses an option and submits it with the form', async () => {
    const onChange = vi.fn();
    render(
      <form aria-label="f">
        <Select label="Role" name="role" defaultValue="member" onChange={onChange}>
          <SelectItem id="owner">Co-owner</SelectItem>
          <SelectItem id="member">Member</SelectItem>
        </Select>
      </form>,
    );
    const form = screen.getByRole('form', { name: 'f' }) as HTMLFormElement;
    expect(new FormData(form).get('role')).toBe('member');
    await userEvent.click(screen.getByRole('button', { name: /Role/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Co-owner' }));
    expect(onChange).toHaveBeenCalledWith('owner');
    expect(new FormData(form).get('role')).toBe('owner');
  });
});

describe('SegmentedControl', () => {
  it('is a radio group with one choice', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Theme"
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        value="light"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getByRole('radio', { name: 'Light' })).toBeChecked();
    await userEvent.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });
});

describe('Switch', () => {
  it('toggles', async () => {
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>Weekly recap</Switch>);
    await userEvent.click(screen.getByRole('switch', { name: 'Weekly recap' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Dialog', () => {
  it('opens from its trigger, closes on Escape, and returns focus', async () => {
    render(
      <DialogTrigger>
        <Button>Rename</Button>
        <Dialog title="Rename account">Body</Dialog>
      </DialogTrigger>,
    );
    const trigger = screen.getByRole('button', { name: 'Rename' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Rename account' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  it('runs the action, then closes', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <DialogTrigger>
        <Button>Delete</Button>
        <ConfirmDialog
          title="Delete this rule?"
          confirmLabel="Delete rule"
          destructive
          onConfirm={onConfirm}
        >
          It can't be undone.
        </ConfirmDialog>
      </DialogTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this rule?' });
    expect(dialog).toHaveFocus(); // not the destructive button
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete rule' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('stays open when the action fails', async () => {
    render(
      <ConfirmDialog
        isOpen
        title="Delete?"
        confirmLabel="Delete"
        onConfirm={() => Promise.reject(new Error('failed'))}
      >
        Body
      </ConfirmDialog>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });
});

describe('Menu', () => {
  it('runs an action', async () => {
    const onAction = vi.fn();
    render(
      <MenuTrigger>
        <Button aria-label="Actions">…</Button>
        <Menu>
          <MenuItem onAction={onAction}>Split</MenuItem>
          <MenuItem>Edit</MenuItem>
        </Menu>
      </MenuTrigger>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Split' }));
    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('Table', () => {
  it('renders rows at the density height and reports sorting', async () => {
    const onSortChange = vi.fn();
    render(
      <Table aria-label="Transactions" onSortChange={onSortChange}>
        <TableHeader>
          <Column id="merchant" isRowHeader allowsSorting>
            Merchant
          </Column>
          <Column id="amount" align="end">
            Amount
          </Column>
        </TableHeader>
        <TableBody>
          <Row id="1">
            <Cell>Corner Café</Cell>
            <Cell align="end">$18.75</Cell>
          </Row>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole('row', { name: /Corner Café/ }).getAttribute('style')).toContain(
      'height: var(--row-h)',
    );
    await userEvent.click(screen.getByRole('columnheader', { name: /Merchant/ }));
    expect(onSortChange).toHaveBeenCalledWith({ column: 'merchant', direction: 'ascending' });
  });
});

describe('Avatar', () => {
  it('uses initials, and is hidden next to a visible name', () => {
    expect(initials('Alex Kim')).toBe('AK');
    expect(initials('sam')).toBe('S');
    expect(initials('Mary Ann de la Cruz')).toBe('MC');
    const { container } = render(<Avatar name="Alex Kim" color="#2f6fdb" />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    render(<Avatar name="Alex Kim" color="#2f6fdb" label="Alex Kim" />);
    expect(screen.getByRole('img', { name: 'Alex Kim' })).toHaveTextContent('AK');
  });
});

describe('toast', () => {
  it('shows a message in a live region', async () => {
    render(<Toaster />);
    act(() => void toast('Split saved.'));
    expect(await screen.findByText('Split saved.')).toBeInTheDocument();
    act(() => toastQueue.visibleToasts.forEach((t) => toastQueue.close(t.key)));
  });
});
