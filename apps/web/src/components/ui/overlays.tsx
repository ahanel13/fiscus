// SPDX-License-Identifier: AGPL-3.0-or-later
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps,
  type MenuProps,
  MenuSection as AriaMenuSection,
  MenuTrigger,
  Modal,
  ModalOverlay,
  type ModalOverlayProps,
  OverlayArrow,
  Popover as AriaPopover,
  type PopoverProps,
  Separator,
  Header,
  SubmenuTrigger,
  Tooltip as AriaTooltip,
  TooltipTrigger,
} from 'react-aria-components';
import { Button } from './button.js';
import { cx, fade, popoverStyles } from './utils.js';

export { DialogTrigger, MenuTrigger, SubmenuTrigger };

type DialogChildren = ReactNode | ((close: () => void) => ReactNode);

export interface DialogProps extends Omit<ModalOverlayProps, 'children' | 'className'> {
  title: string;
  /** Hide the title visually (it is still announced). */
  hideTitle?: boolean;
  children: DialogChildren;
  /**
   * `sheet` slides up from the bottom on phones (menus, quick actions); `drawer` is a full-height
   * panel on the right on larger screens and a sheet on phones (details you edit beside a list).
   */
  variant?: 'center' | 'sheet' | 'drawer';
  size?: 'sm' | 'md' | 'lg';
  role?: 'dialog' | 'alertdialog';
  /** Show a close (×) button in the corner. */
  closeButton?: boolean;
}

/**
 * A modal dialog. Put it inside `<DialogTrigger>` next to the button that opens it, or control it
 * with `isOpen` / `onOpenChange`. Focus is trapped while open and returns to the trigger after.
 */
export function Dialog({
  title,
  hideTitle,
  children,
  variant = 'center',
  size = 'md',
  role,
  closeButton = true,
  isDismissable = true,
  ...props
}: DialogProps) {
  const sheet = variant === 'sheet';
  const drawer = variant === 'drawer';
  return (
    <ModalOverlay
      {...props}
      isDismissable={isDismissable}
      className={clsx(
        'fixed inset-0 z-50 flex bg-black/40',
        drawer
          ? 'items-end justify-center md:items-stretch md:justify-end'
          : sheet
            ? 'items-end justify-center md:items-center md:p-4'
            : 'items-center justify-center p-4',
        fade,
      )}
    >
      <Modal
        className={clsx(
          'max-h-[90dvh] w-full overflow-y-auto border border-border bg-surface text-fg shadow-lg',
          drawer
            ? 'rounded-t-2xl md:h-full md:max-h-none md:max-w-lg md:rounded-none md:border-y-0 md:border-r-0'
            : sheet
              ? 'rounded-t-2xl md:rounded-xl'
              : 'rounded-xl',
          size === 'sm' && 'md:max-w-sm',
          size === 'md' && !drawer && 'max-w-md',
          size === 'lg' && 'max-w-2xl',
          sheet && size === 'md' && 'md:max-w-md',
        )}
      >
        <AriaDialog role={role} className="p-5 outline-none">
          {({ close }) => (
            <>
              <div className="mb-3 flex items-start gap-3">
                <Heading
                  slot="title"
                  className={clsx('flex-1 text-lg font-semibold', hideTitle && 'sr-only')}
                >
                  {title}
                </Heading>
                {closeButton ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close"
                    onPress={close}
                    className="-mr-2 -mt-2"
                  >
                    <X aria-hidden className="size-5" />
                  </Button>
                ) : null}
              </div>
              {typeof children === 'function' ? children(close) : children}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Buttons at the bottom of a dialog, primary action last. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-5 flex flex-wrap justify-end gap-2">{children}</div>;
}

/**
 * Asks before doing something hard to undo. Focus starts on the dialog, not the confirm button,
 * so a stray Enter can't delete anything (WAI-ARIA alert dialog pattern). The confirm button shows
 * progress while `onConfirm` runs, and the dialog closes when it resolves. It stays open on error,
 * so the caller can show what went wrong.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  onConfirm,
  ...props
}: Omit<DialogProps, 'children' | 'role'> & {
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog {...props} title={title} role="alertdialog" size="sm" closeButton={false}>
      {(close) => (
        <>
          <div className="text-sm text-muted">{children}</div>
          <DialogActions>
            <Button variant="secondary" onPress={close} isDisabled={pending}>
              {cancelLabel}
            </Button>
            <Button
              variant={destructive ? 'danger' : 'primary'}
              isPending={pending}
              onPress={async () => {
                setPending(true);
                try {
                  await onConfirm();
                  close();
                } catch {
                  // Stay open: the caller shows what went wrong (e.g. from its mutation's error).
                } finally {
                  setPending(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

export function Popover({ className, children, ...props }: PopoverProps) {
  return (
    <AriaPopover {...props} offset={props.offset ?? 6} className={cx(popoverStyles, className)}>
      {children}
    </AriaPopover>
  );
}

/** A menu of actions. Put it in `<MenuTrigger>` after the button that opens it. */
export function Menu<T extends object>({
  placement,
  className,
  ...props
}: MenuProps<T> & { placement?: PopoverProps['placement'] }) {
  return (
    <Popover placement={placement} className="min-w-48">
      <AriaMenu {...props} className={cx('max-h-80 overflow-auto p-1 outline-none', className)} />
    </Popover>
  );
}

/** A menu item. Give it `href` to navigate, or `onAction` to act. */
export function MenuItem({
  className,
  tone,
  ...props
}: MenuItemProps & { tone?: 'default' | 'danger' }) {
  const textValue =
    props.textValue ?? (typeof props.children === 'string' ? props.children : undefined);
  return (
    <AriaMenuItem
      {...props}
      textValue={textValue}
      className={cx(
        clsx(
          'flex min-h-11 cursor-default items-center gap-2 rounded-md px-2.5 text-sm outline-none sm:min-h-9',
          'focus:bg-surface-2 disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
          tone === 'danger' ? 'text-danger' : 'text-fg',
        ),
        className,
      )}
    />
  );
}

export function MenuSection<T extends object>({
  title,
  children,
}: {
  title?: string;
  children: ReactNode | ((item: T) => ReactNode);
}) {
  return (
    <AriaMenuSection>
      {title ? (
        <Header className="px-2.5 py-1 text-xs font-semibold text-muted">{title}</Header>
      ) : null}
      {children as ReactNode}
    </AriaMenuSection>
  );
}

export function MenuSeparator() {
  return <Separator className="mx-1 my-1 border-t border-border" />;
}

/**
 * A short hint on hover or keyboard focus. Never put essential information only in a tooltip:
 * touch screens can't hover.
 */
export function Tooltip({
  content,
  children,
  placement = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipTrigger delay={500} closeDelay={100}>
      {children}
      <AriaTooltip
        placement={placement}
        offset={8}
        className={clsx('max-w-64 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-md', fade)}
      >
        <OverlayArrow className="group">
          <svg
            width={8}
            height={8}
            viewBox="0 0 8 8"
            className="fill-fg group-placement-bottom:rotate-180 group-placement-left:-rotate-90 group-placement-right:rotate-90"
          >
            <path d="M0 0 L4 4 L8 0" />
          </svg>
        </OverlayArrow>
        {content}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
