"use client";

/**
 * SheetResizeHandle — drag-to-resize grip for a right-anchored Sheet.
 *
 * Sits on the Sheet's leading (left) edge and forwards pointer events to
 * the caller (usually wired up through `useResizableSheet`).
 *
 * Visual language:
 *   - 16px-wide invisible hit zone running the full height of the drawer
 *     for comfortable pointer/touch aim.
 *   - 1px guide line flush with the leading edge (subtle, merges with
 *     the Sheet's existing border-l so there's no double line).
 *   - Centered vertical pill that reads as a drag affordance, like the
 *     grip indicators on resizable splitter panels in IDE shells.
 *   - On hover, the guide and grip brighten to the primary color so the
 *     operator knows it's grabbable.
 */

import type { PointerEvent } from "react";
import { cn } from "./cn";

export interface SheetResizeHandleProps {
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void;
  className?: string;
  ariaLabel?: string;
}

export function SheetResizeHandle({
  onPointerDown,
  onPointerMove,
  onPointerUp,
  className,
  ariaLabel = "Resize drawer",
}: SheetResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      // Explicit `top-0 bottom-0` instead of `inset-y-0` shorthand so a
      // caller passing `top-*` only overrides `top-0`, not the whole
      // shorthand (which would drop `bottom-0` and collapse the hit
      // area).
      className={cn(
        "group absolute top-0 bottom-0 left-0 z-20 w-4 cursor-col-resize touch-none",
        className,
      )}
    >
      {/* Subtle 1px guide line at the leading edge. Defaults to
          `bg-border` so it merges with the SheetContent's border-l
          (no double line), brightens to `bg-primary/40` on hover. */}
      <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover:bg-primary/40 group-data-[dragging=true]:bg-primary/60" />
      {/* Centered grip pill — the actual visual drag affordance.
          Subtle by default (40% opacity, border color) and pops on
          hover/drag. Sized to read clearly without crowding the
          drawer's content. */}
      <div className="pointer-events-none absolute top-1/2 left-0.5 h-10 w-1 -translate-y-1/2 rounded-full bg-border opacity-60 transition-all group-hover:bg-primary/70 group-hover:opacity-100 group-data-[dragging=true]:bg-primary group-data-[dragging=true]:opacity-100" />
    </div>
  );
}
