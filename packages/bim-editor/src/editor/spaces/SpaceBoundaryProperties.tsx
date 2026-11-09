'use client'

import { BOUNDARY_QUANTITY_KEYS, boundingElementWords, measuredValue, spaceBoundaryFacts, type BoundaryFact, type ElementId, type ModelState } from '@permitzip/bim-kernel'
import { isPackRefusal } from '@permitzip/bim-kernel/packs'
import { Button } from '../../ui/button'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Table, TableBody, TableCaption, TableCell, TableRow } from '../../ui/table'

const FT_PER_M = 3.28084
const FT2_PER_M2 = 10.7639104

const ft = (m: number) => `${Math.round(m * FT_PER_M).toLocaleString('en-US')} ft`
const ft2 = (m2: number) => `${Math.round(m2 * FT2_PER_M2).toLocaleString('en-US')} sq ft`

/** The boundary quantities in the order a person reads them, with their units. */
const QUANTITIES: ReadonlyArray<{ readonly key: string; readonly label: string; readonly show: (v: number) => string }> = [
  { key: BOUNDARY_QUANTITY_KEYS.exteriorLength, label: 'Exterior wall length', show: ft },
  { key: BOUNDARY_QUANTITY_KEYS.exteriorWallArea, label: 'Exterior wall area (less doors and windows)', show: ft2 },
  { key: BOUNDARY_QUANTITY_KEYS.interiorWallArea, label: 'Interior wall area (less doors)', show: ft2 },
  { key: BOUNDARY_QUANTITY_KEYS.windowArea, label: 'Window area', show: ft2 },
  { key: BOUNDARY_QUANTITY_KEYS.doorCount, label: 'Doors', show: (v) => String(Math.round(v)) },
  { key: BOUNDARY_QUANTITY_KEYS.ratedLength, label: 'Rated wall length', show: ft },
]

function beyondWords(model: ModelState, f: BoundaryFact): string {
  if (f.otherSide.kind === 'outside') return 'outside'
  if (f.otherSide.kind === 'unknown') return 'not known'
  const s = model.elements[f.otherSide.spaceId]
  return s?.kind === 'space' ? [s.name, s.number].filter((t) => t.trim() !== '').join(' ') || 'another space' : 'another space'
}

/**
 * A space's "Bounded by walls" section: each edge with what bounds it, how
 * long it is, what is beyond it and the doors and windows in it (each row
 * selects its wall), then the boundary quantities. A space drawn or traced
 * says so instead.
 */
export function SpaceBoundaryProperties({ model, spaceId, onSelectElement }: { readonly model: ModelState; readonly spaceId: ElementId; readonly onSelectElement?: (id: ElementId) => void }) {
  const space = model.elements[spaceId]
  if (space?.kind !== 'space') return null
  if (space.bounds.kind !== 'bounded') {
    const how = space.bounds.kind === 'none' ? 'Not drawn yet' : space.origin.kind === 'traced' ? 'Traced over a drawing' : space.origin.kind === 'from_room' ? 'From the room' : 'Drawn'
    return (
      <p className="text-xs text-muted-foreground" data-testid="space-made-how">
        {how}. Its outline doesn’t follow walls; make it with Room from walls to list what bounds it.
      </p>
    )
  }
  const facts = spaceBoundaryFacts(model, spaceId)
  const list = isPackRefusal(facts) ? [] : facts
  return (
    <section className="flex flex-col gap-2" aria-label="Bounded by walls" data-testid="space-bounded-by">
      <h4 className="text-xs font-medium">Bounded by walls{space.bounds.open ? ' (no longer closed: check its walls)' : ''}</h4>
      <ItemGroup>
        {list.map((f, i) => (
          <Item key={`${f.elementId}:${i}`} size="sm" variant="outline" data-testid="space-bounded-by-row" data-element={f.elementId}>
            <ItemContent>
              <ItemTitle>{f.virtual ? `Separation line ${f.elementId}` : boundingElementWords(model.elements, f.elementId)}</ItemTitle>
              <ItemDescription>
                {ft(f.lengthMm / 1000)} · beyond: {beyondWords(model, f)}
                {f.openings.length > 0 ? ` · ${f.openings.map((o) => o.label.toLowerCase()).join(', ')}` : ''}
              </ItemDescription>
            </ItemContent>
            {onSelectElement ? (
              <ItemActions>
                <Button size="sm" variant="ghost" onClick={() => onSelectElement(f.elementId)} aria-label={`Select ${boundingElementWords(model.elements, f.elementId)}`}>
                  Select
                </Button>
              </ItemActions>
            ) : null}
          </Item>
        ))}
      </ItemGroup>
      <Table data-testid="space-boundary-quantities">
        <TableCaption className="sr-only">What is around the space, from its walls</TableCaption>
        <TableBody>
          {QUANTITIES.map((q) => {
            const v = measuredValue(model.elements, spaceId, q.key)
            return (
              <TableRow key={q.key}>
                <TableCell className="text-xs">{q.label}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{v === null ? '—' : q.show(v)}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}
