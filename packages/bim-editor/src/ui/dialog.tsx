"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "./cn"
import { usePortalContainer } from "./overlay-boundary"

/** Portaled popovers/comboboxes opened from inside a Dialog must not dismiss it. */
const DIALOG_FLOATING_SURFACE_SELECTOR =
  "[data-softphone-surface],[data-radix-popper-content-wrapper],[data-slot=select-content],[data-sheet-floating-surface],.pac-container"

function isDialogFloatingSurfaceTarget(target: Element | null): boolean {
  return !!target?.closest(DIALOG_FLOATING_SURFACE_SELECTOR)
}

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[80] bg-black/80 data-[state=closed]:pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, onInteractOutside, onPointerDownOutside, ...props }, ref) => {
  // Mirror the softphone-guard from SheetContent. Four classes of
  // targets must not auto-close the Dialog:
  //   1. Floating softphone surfaces (`data-softphone-surface`) so the
  //      phone stays reachable during any modal flow (Approve handoff,
  //      orphan reconcile, delete confirms, etc.).
  //   2. Any peer Radix popper content — identified by Radix's
  //      `data-radix-popper-content-wrapper` — so clicking an option in
  //      a Select / DropdownMenu / Popover that was opened from a
  //      sibling surface (e.g. the softphone's Visibility picker) does
  //      not dismiss the Dialog behind it.
  //   3. Custom portaled comboboxes (`data-sheet-floating-surface`) and
  //      Radix Select content (`data-slot=select-content`).
  //   4. Google Places `.pac-container` (appended to document.body) — without
  //      this guard, pointerdown-outside swallows `.pac-item` clicks so
  //      place_changed never fires (keyboard Enter still worked).
  //
  // Both onInteractOutside and onPointerDownOutside must guard these
  // targets — pointer-down alone was swallowing SelectItem mouse clicks
  // (keyboard Enter still worked) in dialogs like evidence Move….
  const handleInteractOutside: NonNullable<
    React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onInteractOutside"]
  > = (event) => {
    onInteractOutside?.(event)
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    if (isDialogFloatingSurfaceTarget(target)) {
      event.preventDefault()
    }
  }

  const handlePointerDownOutside: NonNullable<
    React.ComponentPropsWithoutRef<
      typeof DialogPrimitive.Content
    >["onPointerDownOutside"]
  > = (event) => {
    onPointerDownOutside?.(event)
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null
    if (isDialogFloatingSurfaceTarget(target)) {
      event.preventDefault()
    }
  }

  const container = usePortalContainer()
  return (
    <DialogPortal container={container}>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        onInteractOutside={handleInteractOutside}
        onPointerDownOutside={handlePointerDownOutside}
        className={cn(
          "fixed left-[50%] top-[50%] z-[80] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=closed]:pointer-events-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
          className
        )}
        {...props}
      >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring-3 focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
