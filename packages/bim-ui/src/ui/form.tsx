import * as React from "react";
import { cn } from "./cn";

/**
 * shadcn/ui Card, Input, Textarea, Label and Field (MIT), vendored for
 * MutinyBIM, plus a native select styled to match (server-rendered pages
 * post plain forms). Colors come only from `--mutiny-*` variables.
 */

export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return <section data-slot="card" className={cn("flex flex-col gap-4 rounded-[calc(var(--mutiny-radius)*2)] border border-(--mutiny-border) bg-(--mutiny-panel) p-5 text-(--mutiny-text) shadow-sm", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("flex flex-col gap-1", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 data-slot="card-title" className={cn("text-lg leading-tight [font-family:var(--mutiny-font-heading)] [font-weight:var(--mutiny-heading-weight)]", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-sm/relaxed text-(--mutiny-muted)", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("flex flex-col gap-3 text-sm", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("flex flex-wrap items-center gap-2", className)} {...props} />;
}

const fieldControl =
  "w-full min-w-0 rounded-(--mutiny-radius) border border-(--mutiny-border) bg-(--mutiny-field) px-2.5 text-sm text-(--mutiny-text) outline-none transition-colors placeholder:text-(--mutiny-muted) focus-visible:ring-2 focus-visible:ring-(--mutiny-focus-ring) focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-(--mutiny-danger)";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn(fieldControl, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(fieldControl, "min-h-20 py-2", className)} {...props} />;
}

export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn(fieldControl, "h-9 pr-7", className)} {...props} />;
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label data-slot="label" className={cn("text-sm font-medium text-(--mutiny-text)", className)} {...props} />;
}

/** One labelled control: label, control, then an optional hint below. */
export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-hint" className={cn("text-xs text-(--mutiny-muted)", className)} {...props} />;
}
