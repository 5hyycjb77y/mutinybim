import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "./cn";

/** shadcn/ui Button (MIT), vendored for MutinyBIM. Colors come only from `--mutiny-*` variables. */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-(--mutiny-radius) border border-transparent text-sm font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-(--mutiny-focus-ring) focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-(--mutiny-accent) text-(--mutiny-accent-foreground) hover:bg-(--mutiny-accent)/85",
        outline: "border-(--mutiny-border) bg-(--mutiny-panel) text-(--mutiny-text) hover:bg-(--mutiny-subtle)",
        ghost: "text-(--mutiny-text) hover:bg-(--mutiny-subtle)",
        destructive: "bg-(--mutiny-danger) text-(--mutiny-danger-foreground) hover:bg-(--mutiny-danger)/85",
        link: "text-(--mutiny-text) underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-2.5",
        sm: "h-7 px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 px-3",
        icon: "size-8",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant = "default", size = "default", asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
