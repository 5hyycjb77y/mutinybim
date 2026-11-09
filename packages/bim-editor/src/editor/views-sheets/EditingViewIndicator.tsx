'use client'

import { Check } from 'lucide-react'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

export const FINISH_EDITING_HINT = 'Esc or double-click outside to finish'

/**
 * Floats over the drawing while a placed view is edited in place. It must never
 * take layout space (product decision, Oct 21: the old full-width banner shifted the whole
 * sheet down on enter and up on exit), and only its button takes the pointer so
 * the canvas under it still gets clicks and drags.
 */
export function EditingViewIndicator({ viewName, onDone }: { viewName: string; onDone: () => void }) {
  return (
    <Badge
      variant="outline"
      className="pointer-events-none absolute left-3 top-3 z-20 max-w-[calc(100%-1.5rem)] gap-1.5 rounded-full bg-background/95 py-0.5 pl-3 pr-0.5 font-normal text-foreground shadow-sm"
      role="status"
      aria-live="polite"
      data-testid="editing-view-banner"
    >
      <span className="truncate">
        Editing <span className="font-medium">{viewName}</span>
      </span>
      <span className="sr-only">. {FINISH_EDITING_HINT}.</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="xs" className="pointer-events-auto rounded-full" onClick={onDone} data-testid="finish-editing-view">
            <Check data-icon="inline-start" />
            Done
          </Button>
        </TooltipTrigger>
        <TooltipContent>{FINISH_EDITING_HINT}</TooltipContent>
      </Tooltip>
    </Badge>
  )
}
