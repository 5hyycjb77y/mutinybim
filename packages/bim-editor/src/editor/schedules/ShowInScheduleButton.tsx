'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { TableProperties } from 'lucide-react'
import { documentIndex, type ModelState } from '@permitzip/bim-kernel'
import { ScheduleDefinitionError, buildRowSet } from '@permitzip/bim-kernel/schedules'
import { Button } from '../../ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { viewScheduleDefinition } from '../../contracts/bim/schedules/view-definition'

/** The model's list schedules that have a row for this element. */
export function schedulesListing(model: ModelState, elementId: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = []
  for (const view of documentIndex(model).views) {
    if (view.viewType !== 'schedule') continue
    const def = viewScheduleDefinition(model, view.id)
    if (!def) continue
    try {
      const rows = buildRowSet(model, def, { viewId: view.id, revision: model.revision })
      if (rows.elementIds.includes(elementId)) out.push({ id: view.id, name: view.name })
    } catch (err) {
      if (err instanceof ScheduleDefinitionError) continue
      console.error('[ShowInSchedule] reading a schedule failed', { viewId: view.id, err })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/**
 * Element properties › Show in schedule (SCHEDULES-PLAN §7): the schedules
 * this item appears in, worked out when pressed (not on every model change,
 * so a large model pays nothing while the item is merely selected). One
 * opens straight away; several offer a menu; none says so.
 */
export function ShowInScheduleButton({ model, elementId, onOpen }: { readonly model: ModelState; readonly elementId: string; readonly onOpen: (viewId: string) => void }) {
  const [listing, setListing] = useState<{ elementId: string; items: { id: string; name: string }[] } | null>(null)
  const items = listing?.elementId === elementId ? listing.items : null
  const press = () => {
    const found = schedulesListing(model, elementId)
    const only = found.length === 1 ? found[0] : undefined
    if (only) {
      onOpen(only.id)
      return
    }
    if (found.length === 0) toast.info('No schedule lists this item yet. Make one with New schedule… on the ribbon.')
    setListing({ elementId, items: found })
  }
  return (
    <DropdownMenu open={items !== null && items.length > 1} onOpenChange={(open) => !open && setListing(null)}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="show-in-schedule"
          onPointerDown={(e) => e.preventDefault()}
          onClick={press}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              press()
            }
          }}
        >
          <TableProperties data-icon="inline-start" />
          Show in schedule
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Schedules listing this item</DropdownMenuLabel>
        <DropdownMenuGroup>
          {(items ?? []).map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => onOpen(s.id)}>
              {s.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
