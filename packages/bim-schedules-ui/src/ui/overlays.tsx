"use client";

import { useMutinyPortalContainer } from "@permitzip/bim-ui";
import { AlertDialog as AlertDialogPrimitive, Dialog as DialogPrimitive, DropdownMenu as MenuPrimitive } from "radix-ui";
import { useRef, type ReactNode } from "react";

/**
 * shadcn-shaped overlays (Radix, MIT) for the schedule surfaces: a confirm
 * dialog, a side sheet and an overflow menu. They portal into the Mutiny theme
 * root so they keep the `--mutiny-*` variables, and Esc always closes them.
 * Candidates to move into `@permitzip/bim-ui` once a second surface needs them.
 */

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Cancel is the default: it takes focus on open, and Esc or a click outside cancels. */
export function ConfirmDialog({ open, title, children, confirmLabel, cancelLabel = "Cancel", destructive, onConfirm, onCancel }: ConfirmDialogProps) {
  const container = useMutinyPortalContainer();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogPrimitive.Portal container={container ?? undefined}>
        <AlertDialogPrimitive.Overlay className="mutiny-sched-overlay" />
        <AlertDialogPrimitive.Content
          className="mutiny-sched-dialog"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
        >
          <AlertDialogPrimitive.Title className="mutiny-sched-dialog-title">{title}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description asChild>
            <div className="mutiny-sched-dialog-body">{children}</div>
          </AlertDialogPrimitive.Description>
          <div className="mutiny-sched-dialog-actions">
            <AlertDialogPrimitive.Cancel ref={cancelRef} className="mutiny-sched-button">
              {cancelLabel}
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action className={destructive ? "mutiny-sched-button is-danger" : "mutiny-sched-button is-primary"} onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}

export interface SheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly side?: "right" | "left";
  /** Element id to focus (and scroll to) on open, e.g. a section heading. */
  readonly initialFocusId?: string;
}

export function Sheet({ open, onOpenChange, title, description, children, footer, side = "right", initialFocusId }: SheetProps) {
  const container = useMutinyPortalContainer();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Overlay className="mutiny-sched-overlay" />
        <DialogPrimitive.Content
          className={`mutiny-sched-sheet is-${side}`}
          {...(description ? {} : { "aria-describedby": undefined })}
          onOpenAutoFocus={(e) => {
            if (!initialFocusId) return;
            const target = (e.currentTarget as HTMLElement | null)?.ownerDocument.getElementById(initialFocusId);
            if (!target) return;
            e.preventDefault();
            target.focus();
            target.scrollIntoView?.({ block: "start" });
          }}
        >
          <header className="mutiny-sched-sheet-header">
            <DialogPrimitive.Title className="mutiny-sched-dialog-title">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mutiny-sched-muted">{description}</DialogPrimitive.Description> : null}
            <DialogPrimitive.Close className="mutiny-sched-icon-button" aria-label="Close">
              ×
            </DialogPrimitive.Close>
          </header>
          <div className="mutiny-sched-sheet-body">{children}</div>
          {footer ? <footer className="mutiny-sched-sheet-footer">{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Dialog({ open, onOpenChange, title, children, footer }: DialogProps) {
  const container = useMutinyPortalContainer();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={container ?? undefined}>
        <DialogPrimitive.Overlay className="mutiny-sched-overlay" />
        <DialogPrimitive.Content className="mutiny-sched-dialog" aria-describedby={undefined}>
          <DialogPrimitive.Title className="mutiny-sched-dialog-title">{title}</DialogPrimitive.Title>
          <div className="mutiny-sched-dialog-body">{children}</div>
          {footer ? <div className="mutiny-sched-dialog-actions">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface MenuItem {
  readonly label: string;
  readonly onSelect?: () => void;
  /** Shown when the item can't be used here, so a disabled item says why. */
  readonly disabledReason?: string;
}

export function OverflowMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const container = useMutinyPortalContainer();
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger className="mutiny-sched-button is-ghost" aria-label={label} title={label}>
        ⋯
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal container={container ?? undefined}>
        <MenuPrimitive.Content className="mutiny-sched-menu" align="end" sideOffset={4}>
          {items.map((item) => (
            <MenuPrimitive.Item key={item.label} className="mutiny-sched-menu-item" disabled={!item.onSelect} onSelect={() => item.onSelect?.()}>
              <span>{item.label}</span>
              {!item.onSelect && item.disabledReason ? <span className="mutiny-sched-muted mutiny-sched-menu-reason">{item.disabledReason}</span> : null}
            </MenuPrimitive.Item>
          ))}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
