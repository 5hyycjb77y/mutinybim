'use client'

import { useEffect, useMemo } from 'react'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { type ModelState } from '@permitzip/bim-kernel'
import { electricalCheck, type CheckItem, type ElectricalLoadEngine } from '@permitzip/bim-pack-electrical'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../../ui/item'

const ICON = { error: CircleAlert, warning: TriangleAlert, info: Info } as const
const WORD = { error: 'Must fix', warning: 'Check', info: 'Note' } as const

/**
 * Electrical › Check: everything that needs attention across the model, from
 * the same aggregation engine the panel view totals with (overloads, phase
 * unbalance, a bus above its feeding breaker, a voltage that no longer
 * matches, breakers against equipment nameplates, feeder types the catalog
 * lacks) plus loads on no circuit. Click an item to select what it is about;
 * Open panel shows its panel view. Esc closes.
 */
export function CheckPanel({ model, engine, rulesLabel, onSelect, onOpenPanel, onClose }: { readonly model: ModelState; readonly engine: ElectricalLoadEngine; readonly rulesLabel: string; readonly onSelect: (ids: readonly string[]) => void; readonly onOpenPanel: (panelId: string) => void; readonly onClose: () => void }) {
  const items = useMemo<CheckItem[]>(() => electricalCheck(engine, model), [engine, model])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const counts = { error: items.filter((i) => i.severity === 'error').length, warning: items.filter((i) => i.severity === 'warning').length }
  return (
    <section className="flex min-h-0 flex-col gap-2 p-3" aria-label="Electrical check" data-testid="electrical-check">
      <header className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Electrical check</h2>
        {counts.error > 0 && <Badge variant="destructive">{counts.error} to fix</Badge>}
        {counts.warning > 0 && <Badge variant="outline">{counts.warning} to check</Badge>}
        <span className="text-xs text-muted-foreground">{rulesLabel}</span>
        <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close the electrical check" onClick={onClose}>
          <X />
        </Button>
      </header>
      {items.length === 0 ? (
        <Empty className="border py-6" data-testid="electrical-check-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleCheck />
            </EmptyMedia>
            <EmptyTitle>Nothing needs attention</EmptyTitle>
            <EmptyDescription>Every load is on a circuit, no panel is overloaded or unbalanced, and every voltage matches.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="min-h-0 gap-1 overflow-y-auto">
          {items.map((item, i) => {
            const Icon = ICON[item.severity]
            return (
              <Item key={`${item.kind}-${i}`} variant="outline" size="sm" data-testid="electrical-check-item" data-kind={item.kind}>
                <ItemMedia variant="icon">
                  <Icon className={item.severity === 'error' ? 'text-danger-600' : item.severity === 'warning' ? 'text-warning-700' : 'text-muted-foreground'} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="text-xs font-normal">{item.message}</ItemTitle>
                  <ItemDescription className="text-xs">{WORD[item.severity]}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="outline" size="sm" disabled={item.elementIds.length === 0} title={item.elementIds.length === 0 ? 'Nothing in the model to select for this one' : undefined} onClick={() => onSelect(item.elementIds)} data-testid="electrical-check-select">
                    Select{item.elementIds.length > 1 ? ` ${item.elementIds.length}` : ''}
                  </Button>
                  {item.panelId && (
                    <Button variant="ghost" size="sm" onClick={() => onOpenPanel(item.panelId as string)}>
                      Open panel
                    </Button>
                  )}
                </ItemActions>
              </Item>
            )
          })}
        </ItemGroup>
      )}
    </section>
  )
}
