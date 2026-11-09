'use client'

import { useEffect, useState, type ReactNode, type Ref } from 'react'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { cn } from '../../ui/cn'
import { useLayoutPrefs } from './LayoutPrefsProvider'
import { RailResizeHandle } from './RailResizeHandle'

/** Properties' saved layout (`bim_ui_layout_prefs.surface`). */
export const PROPERTIES_SURFACE = 'properties'
export const PROPERTIES_DEFAULT_WIDTH_PX = 320
/** The `collapsed` key for the whole sidebar (its sections keep their own ids). Saved with the person's layout: never rename it. */
export const SIDE_RAIL_COLLAPSED_KEY = 'whole'
/** Width of the strip a collapsed sidebar leaves, px. */
export const SIDE_RAIL_STRIP_PX = 36

interface Props {
  /** Which side of the screen the sidebar sits on; its drag edge is the inner one. */
  readonly side: 'left' | 'right'
  readonly surface: string
  /** What it is called on its buttons ("Properties" → "Collapse Properties" / "Show Properties"). */
  readonly title: string
  readonly defaultWidthPx: number
  /** Position, background, border and shadow of the sidebar itself. */
  readonly className?: string
  /** Layout of the scrolling content (padding, gap). */
  readonly bodyClassName?: string
  /** The width it takes now (the strip's when collapsed), for whatever sits beside it. */
  readonly onWidthChange?: (px: number) => void
  readonly ref?: Ref<HTMLElement>
  readonly children: ReactNode
}

/**
 * A Building Model sidebar the person can drag wider or narrower and collapse
 * to a thin strip (the product owner, C6: "these little sidebars, I can't stretch or
 * collapse"). Width and collapsed state are theirs, saved in the database
 * through the layout prefs, never browser storage.
 */
export function ResizableSideRail({ side, surface, title, defaultWidthPx, className, bodyClassName, onWidthChange, ref, children }: Props) {
  const prefs = useLayoutPrefs()
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  // A toggle made before the saved layout arrives wins over it.
  const [localCollapsed, setLocalCollapsed] = useState<boolean | null>(null)
  const collapsed = localCollapsed ?? prefs.isCollapsed(surface, SIDE_RAIL_COLLAPSED_KEY, false)
  const width = dragWidth ?? prefs.width(surface) ?? defaultWidthPx
  const shown = collapsed ? SIDE_RAIL_STRIP_PX : width

  useEffect(() => {
    onWidthChange?.(shown)
  }, [shown, onWidthChange])

  const setCollapsed = (next: boolean) => {
    setLocalCollapsed(next)
    prefs.setCollapsed(surface, SIDE_RAIL_COLLAPSED_KEY, next)
  }
  const CollapseIcon = side === 'right' ? ChevronsRight : ChevronsLeft
  const ShowIcon = side === 'right' ? ChevronsLeft : ChevronsRight

  if (collapsed) {
    return (
      <aside ref={ref} className={cn('flex flex-col items-center gap-2 py-2', className)} style={{ width: SIDE_RAIL_STRIP_PX }} aria-label={title} data-testid={`side-rail-${surface}`} data-collapsed="true">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Show ${title}`} onClick={() => setCollapsed(false)} data-testid={`side-rail-show-${surface}`}>
              <ShowIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side={side === 'right' ? 'left' : 'right'}>Show {title}</TooltipContent>
        </Tooltip>
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase [writing-mode:vertical-rl]" aria-hidden>
          {title}
        </span>
      </aside>
    )
  }

  return (
    <aside ref={ref} className={cn('flex flex-col', className)} style={{ width }} aria-label={title} data-testid={`side-rail-${surface}`} data-collapsed="false">
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto', bodyClassName)}>
        <div className={cn('-mb-2 flex shrink-0', side === 'right' ? 'justify-start' : 'justify-end')}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-6" aria-label={`Collapse ${title}`} onClick={() => setCollapsed(true)} data-testid={`side-rail-collapse-${surface}`}>
                <CollapseIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Collapse {title} to a strip</TooltipContent>
          </Tooltip>
        </div>
        {children}
      </div>
      <RailResizeHandle edge={side === 'right' ? 'left' : 'right'} ariaLabel={`Resize ${title}`} width={width} defaultWidth={defaultWidthPx} onPreview={setDragWidth} onCommit={(px) => prefs.setWidth(surface, px)} />
    </aside>
  )
}
