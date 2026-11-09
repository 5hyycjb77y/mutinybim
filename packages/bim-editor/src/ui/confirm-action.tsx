"use client";

import { type ReactElement, type ReactNode, cloneElement } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog";

/**
 * ConfirmAction — drop-in AlertDialog wrapper for destructive actions.
 *
 * Usage:
 *   <ConfirmAction
 *     title="Delete holiday group"
 *     description="Assignments in this group will be detached."
 *     confirmLabel="Delete"
 *     destructive
 *     onConfirm={() => handleDelete(group.id)}
 *   >
 *     <Button aria-label="Delete group" variant="ghost" size="icon">
 *       <Trash2 aria-hidden="true" />
 *     </Button>
 *   </ConfirmAction>
 *
 * The rendered child button becomes the AlertDialog trigger — so its
 * own onClick is preserved for event-stop-propagation etc., but the
 * actual destructive operation only runs after the confirm click.
 *
 * Why a wrapper instead of reinventing AlertDialog each time: every
 * destructive click-through in the leave UI (cancel booking, remove
 * member, remove holiday, remove assignment) was firing immediately
 * on first click. Standardising the confirmation flow here removes
 * ~15 lines of AlertDialog boilerplate from each callsite and makes
 * sure the "Cancel" and "Confirm" buttons look the same everywhere.
 */
export interface ConfirmActionProps {
  children: ReactElement;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmAction({
  children,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: ConfirmActionProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{cloneElement(children)}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void onConfirm()}
            className={
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
