"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "./ui/cn";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Spinner } from "./ui/primitives";
import { useMutinyPresentation, useMutinyTheme } from "./theme-provider";
import { wordmarkLayout } from "./wordmark-paths";

const WORDMARK = wordmarkLayout();

/** The MUTINY slab wordmark. Inherits `color`. */
export function MutinyWordmark({ className, title = "MUTINY", ...props }: ComponentProps<"svg"> & { title?: string }) {
  return (
    <svg viewBox={`0 0 ${WORDMARK.width} 100`} role="img" aria-label={title} className={cn("h-6 w-auto", className)} {...props}>
      <title>{title}</title>
      <g fill="currentColor">
        {WORDMARK.glyphs.map((g) => (
          <path key={`${g.char}-${g.x}`} transform={`translate(${g.x} 0)`} d={g.d} />
        ))}
      </g>
    </svg>
  );
}

/** The crate icon mark: the theme's `iconUrl` when set, else the built-in vector crate. */
export function MutinyIcon({ className, label }: { className?: string; label?: string }) {
  const theme = useMutinyTheme();
  const name = label ?? theme.brand.productName;
  if (theme.brand.iconUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- open-source package: no Next.js image pipeline here
    return <img src={theme.brand.iconUrl} alt={name} className={cn("size-6 object-contain", className)} />;
  }
  return (
    <svg viewBox="0 0 64 64" role="img" aria-label={name} className={cn("size-6", className)}>
      <title>{name}</title>
      <g transform="rotate(24 32 32)">
        <path fill="var(--mutiny-text)" d="M46 15l9 6v33l-9-5z" />
        <rect x="9" y="15" width="37" height="34" fill="var(--mutiny-accent)" stroke="var(--mutiny-text)" strokeWidth="3" strokeLinejoin="round" />
        <g fill="var(--mutiny-text)">
          <rect x="19" y="15" width="4" height="34" />
          <rect x="34" y="15" width="4" height="34" />
          <rect x="9" y="25" width="37" height="1.1" />
          <rect x="9" y="32" width="37" height="1.1" />
          <rect x="9" y="39" width="37" height="1.1" />
        </g>
      </g>
    </svg>
  );
}

/** The small "MutinyBIM" mark an embedding host shows in its header. */
export function MutinyMark({ className }: { className?: string }) {
  const theme = useMutinyTheme();
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-semibold text-(--mutiny-muted)", className)} data-testid="mutiny-mark">
      <MutinyIcon className="size-4" />
      <span className="[font-family:var(--mutiny-font-heading)] tracking-wide">{theme.brand.productName}</span>
    </span>
  );
}

/** Opening / loading screen. Standalone shows the full brand; embedded a quiet spinner with the small mark. */
export function MutinySplash({ status, className }: { status: string; className?: string }) {
  const presentation = useMutinyPresentation();
  const theme = useMutinyTheme();
  if (presentation === "embedded") {
    return (
      <div role="status" aria-live="polite" className={cn("flex flex-col items-center gap-2 text-sm text-(--mutiny-muted)", className)} data-testid="mutiny-splash" data-presentation="embedded">
        <Spinner className="size-5" />
        <span>{status}</span>
        <MutinyMark />
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" className={cn("flex flex-col items-center gap-5 text-(--mutiny-text)", className)} data-testid="mutiny-splash" data-presentation="standalone">
      {theme.brand.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- open-source package: no Next.js image pipeline here
        <img src={theme.brand.logoUrl} alt={`${theme.brand.productName} logo`} className="w-56 max-w-[60vw]" />
      ) : (
        <MutinyIcon className="size-20" />
      )}
      <MutinyWordmark className="h-8" title={theme.brand.productName} />
      <span className="flex items-center gap-2 text-sm text-(--mutiny-muted)">
        <Spinner className="size-4" />
        {status}
      </span>
    </div>
  );
}

/** Branded empty state. Standalone leads with the logo; embedded with the icon mark. */
export function MutinyEmptyState({ title, description, children, className, "data-testid": testId }: { title: string; description: ReactNode; children?: ReactNode; className?: string; "data-testid"?: string }) {
  const presentation = useMutinyPresentation();
  const theme = useMutinyTheme();
  return (
    <Empty className={className} data-testid={testId} data-presentation={presentation}>
      <EmptyHeader>
        <EmptyMedia>
          {presentation === "standalone" && theme.brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- open-source package: no Next.js image pipeline here
            <img src={theme.brand.logoUrl} alt={`${theme.brand.productName} logo`} className="w-40" />
          ) : (
            <MutinyIcon className={presentation === "standalone" ? "size-14" : "size-8"} />
          )}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}
