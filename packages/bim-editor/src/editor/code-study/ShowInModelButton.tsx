'use client'

import { Box } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import type { RequirementLink } from './code-study-client'
import { showInModelHref } from './useSelectFromUrl'

export const NO_LINKS_REASON = 'Nothing in the Building Model is linked to this requirement yet.'

/** The link "Show in model" opens: what the requirement is anchored to first, then anything it reads or is fulfilled by. */
export function primaryLink(links: readonly RequirementLink[]): RequirementLink | null {
  const placed = links.filter((link) => link.target_kind !== 'model')
  return placed.find((link) => link.link_kind === 'anchor') ?? placed[0] ?? null
}

/**
 * Code Map › a requirement › Show in model: opens the Building Model in its own
 * window (the same one "Open in new window" uses) with the linked element or
 * space selected. Disabled, with the reason, when nothing is linked.
 */
export function ShowInModelButton({ projectId, links, problem = null }: { projectId: string; links: readonly RequirementLink[]; problem?: string | null }) {
  const target = problem ? null : primaryLink(links)
  const others = links.filter((link) => link.target_kind !== 'model').length - 1
  const hint = problem ? problem : !target ? NO_LINKS_REASON : others > 0 ? `Opens the Building Model on what this requirement is anchored to (${others} more linked).` : 'Opens the Building Model with the linked item selected.'

  const open = () => {
    if (!target) return
    const win = window.open(showInModelHref(projectId, target.target_id), `mutinybim-${projectId}`)
    if (!win) {
      toast.error('Your browser blocked the Building Model window. Allow pop-ups for this site, then try again.')
      return
    }
    win.opener = null
    win.focus()
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button swallows hover; the wrapper keeps the reason reachable. */}
        <span tabIndex={target ? -1 : 0} className="inline-flex">
          <Button variant="ghost" size="sm" disabled={!target} onClick={open} data-testid="code-study-show-in-model">
            <Box data-icon="inline-start" />
            Show in model
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}
