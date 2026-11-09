'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '../../ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import { cn } from '../../ui/cn'
import { useLayoutPrefs } from './LayoutPrefsProvider'

export interface LayoutSectionProps {
  /** Which side this section is on (`rail`, `properties`): the saved layout is per side. */
  readonly surface: string
  /** Stable id, saved with the person's layout. */
  readonly id: string
  readonly title: string
  /** A short count or state after the title ("12", "2 hidden"). */
  readonly meta?: ReactNode
  /** At most one action, at the right of the header (Three Apples: title, collapse, one action). */
  readonly action?: ReactNode
  readonly defaultCollapsed?: boolean
  /** Overrides the root's test id (a list that keeps its old id). */
  readonly testId?: string
  readonly className?: string
  readonly children: ReactNode
}

/**
 * One section of a Building Model side: the same header everywhere (a
 * chevron and title that collapse it, an optional count, at most one action)
 * and its body. Collapsed state is the person's, saved in the database by
 * `LayoutPrefsProvider`. The body stays mounted while collapsed so a dialog
 * it owns (Link a model…) still opens from the ribbon.
 */
export function LayoutSection({ surface, id, title, meta, action, defaultCollapsed = false, testId, className, children }: LayoutSectionProps) {
  const prefs = useLayoutPrefs()
  // A toggle made before the saved layout arrives wins over it.
  const [local, setLocal] = useState<boolean | null>(null)
  const collapsed = local ?? prefs.isCollapsed(surface, id, defaultCollapsed)
  const contentId = `layout-section-${surface}-${id}`
  return (
    <Collapsible
      open={!collapsed}
      onOpenChange={(open) => {
        setLocal(!open)
        prefs.setCollapsed(surface, id, !open)
      }}
      className={cn('flex shrink-0 flex-col', className)}
      data-testid={testId ?? `panel-section-${id}`}
      data-section-id={id}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="flex min-h-8 items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 min-w-0 flex-1 justify-start gap-1 px-2 text-sm font-medium"
            aria-controls={contentId}
            data-testid={`panel-section-toggle-${id}`}
          >
            <ChevronRight data-icon="inline-start" className={cn('transition-transform', !collapsed && 'rotate-90')} aria-hidden />
            <span className="truncate">{title}</span>
            {meta !== undefined && meta !== null && <span className="ml-1 shrink-0 text-xs font-normal text-muted-foreground tabular-nums">{meta}</span>}
          </Button>
        </CollapsibleTrigger>
        {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
      </div>
      <CollapsibleContent forceMount id={contentId} className="flex flex-col gap-3 pt-1 data-[state=closed]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
