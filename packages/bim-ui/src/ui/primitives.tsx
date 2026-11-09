"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Separator as SeparatorPrimitive } from "radix-ui";
import { cn } from "./cn";

/** shadcn/ui Badge, Separator, Spinner, Empty and Alert (MIT), vendored for MutinyBIM. Colors only from `--mutiny-*`. */

const badgeVariants = cva("inline-flex items-center gap-1 rounded-(--mutiny-radius) border px-2 py-0.5 text-xs font-semibold", {
  variants: {
    variant: {
      default: "border-transparent bg-(--mutiny-accent) text-(--mutiny-accent-foreground)",
      secondary: "border-transparent bg-(--mutiny-subtle) text-(--mutiny-muted)",
      destructive: "border-transparent bg-(--mutiny-danger) text-(--mutiny-danger-foreground)",
      outline: "border-(--mutiny-border) text-(--mutiny-text)",
    },
  },
  defaultVariants: { variant: "default" },
});

export type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn("shrink-0 bg-(--mutiny-border) data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:w-px data-[orientation=vertical]:self-stretch", className)}
      {...props}
    />
  );
}

export function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg role="status" aria-label="Loading" viewBox="0 0 24 24" fill="none" className={cn("size-4 animate-spin", className)} {...props}>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty" className={cn("flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-balance", className)} {...props} />;
}

export function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-header" className={cn("flex max-w-sm flex-col items-center gap-2", className)} {...props} />;
}

export function EmptyMedia({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-icon" className={cn("mb-2 flex shrink-0 items-center justify-center", className)} {...props} />;
}

export function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-title" className={cn("text-base [font-weight:var(--mutiny-heading-weight)] [font-family:var(--mutiny-font-heading)]", className)} {...props} />;
}

export function EmptyDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-description" className={cn("text-sm/relaxed text-(--mutiny-muted)", className)} {...props} />;
}

export function EmptyContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="empty-content" className={cn("flex w-full max-w-sm min-w-0 flex-col items-center gap-2.5 text-sm", className)} {...props} />;
}

const alertVariants = cva("relative grid w-full gap-0.5 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-panel) px-3 py-2 text-left text-sm", {
  variants: {
    variant: {
      default: "text-(--mutiny-text)",
      destructive: "text-(--mutiny-danger)",
    },
  },
  defaultVariants: { variant: "default" },
});

export function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("text-sm text-(--mutiny-muted)", className)} {...props} />;
}
