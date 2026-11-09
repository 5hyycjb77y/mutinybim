'use client'

import { useMemo } from 'react'
import { ShieldCheck } from 'lucide-react'
import { derivedZoneCandidates, type Command, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { newElementId } from '../placement'

/**
 * Code zones the equipment on this plan derives (the NEC 110.26(E) dedicated
 * space above each panel), from the same kernel rule the electrical check
 * reads. "Keep as a zone" stores only the panel and the rule; the zone
 * follows the panel when it moves.
 */
export function CodeZonesList({ model, levelId, editReason, send }: { readonly model: ModelState; readonly levelId: ElementId | null; readonly editReason: string | null; readonly send: (command: Command, label: string) => boolean }) {
  const candidates = useMemo(() => derivedZoneCandidates(model, { levelId }), [model, levelId])
  if (candidates.length === 0) return null
  return (
    <section className="flex flex-col gap-2 border-t pt-2" aria-label="Code zones from equipment" data-testid="spaces-code-zones">
      <h3 className="text-xs font-medium text-muted-foreground">Code zones from equipment</h3>
      <ItemGroup>
        {candidates.map((c) => {
          const first = c.regions[0]
          const highFt = first ? Math.round(((first.topMm - first.bottomMm) / 304.8) * 10) / 10 : null
          return (
            <Item key={`${c.hostId}:${c.rule}`} size="xs" variant="outline" data-testid="spaces-code-zone" data-host={c.hostId} data-zone={c.zoneId ?? ''}>
              <ItemContent>
                <ItemTitle>
                  {first?.name ?? c.label} {c.hostLabel}
                  {c.zoneId ? <Badge variant="secondary">Zone</Badge> : null}
                </ItemTitle>
                <ItemDescription>
                  {highFt !== null ? `Up to ${highFt} ft above it, ends at a suspended ceiling or the structure` : c.label}
                  {first?.cite ? ` · ${first.cite}` : ''}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {c.zoneId ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={editReason !== null}
                    title={editReason ?? 'Keep it as a zone in the list; it follows the equipment when it moves'}
                    onClick={() => send({ type: 'accept_derived_zone', zoneId: newElementId('zone'), hostId: c.hostId, rule: c.rule }, 'Keep code zone')}
                    data-testid="spaces-code-zone-keep"
                  >
                    <ShieldCheck data-icon="inline-start" />
                    Keep as a zone
                  </Button>
                )}
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
    </section>
  )
}
