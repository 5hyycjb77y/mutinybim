"use client";

import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "./cn";

/** shadcn/ui ToggleGroup (MIT), vendored for MutinyBIM. Colors come only from `--mutiny-*` variables. */
function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("inline-flex items-center gap-0.5 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-panel) p-0.5", className)}
      {...props}
    />
  );
}

/** Pressed styling keys off aria-checked / aria-pressed: a Tooltip trigger wrapping an item overwrites its data-state. */
function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-[calc(var(--mutiny-radius)-2px)] text-(--mutiny-muted) transition-colors outline-none hover:bg-(--mutiny-subtle) hover:text-(--mutiny-text) focus-visible:ring-2 focus-visible:ring-(--mutiny-focus-ring) disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-(--mutiny-accent) aria-checked:text-(--mutiny-accent-foreground) aria-pressed:bg-(--mutiny-accent) aria-pressed:text-(--mutiny-accent-foreground) [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
