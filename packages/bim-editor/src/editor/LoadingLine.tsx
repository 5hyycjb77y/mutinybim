'use client'

import { Spinner } from '../ui/spinner'

/** Shown while a part of the page that loads on demand (off the page's first download) arrives. */
export function LoadingLine({ label }: { readonly label: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status" data-testid="loading-line">
      <Spinner aria-hidden />
      {label}
    </p>
  )
}
