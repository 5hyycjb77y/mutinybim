'use client'

import { useMemo, useState } from 'react'
import { CircleAlert, ListX, MapPin } from 'lucide-react'
import type { PropertyRow, ReferenceItemProperties } from '@permitzip/bim-viewer-3d'
import type { RevitElementParameters, UnplacedElementView } from '../contracts/building-model/revit-parameters-contract'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty'
import { Input } from '../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../ui/item'
import { Spinner } from '../ui/spinner'
import type { RevitState } from './model-session'

interface Section {
  readonly key: string
  readonly title: string
  readonly badge: string | null
  readonly origin: 'revit' | 'ifc'
  readonly rows: readonly PropertyRow[]
}

/** The sections the panel shows, in order: the element itself, its own sets, its type's sets, systems, connections. */
export function propertySections(properties: ReferenceItemProperties): Section[] {
  const element: PropertyRow[] = [
    ...(properties.ifcClass ? [{ name: 'IFC class', value: properties.ifcClass }] : []),
    ...(properties.typeName ? [{ name: 'Type', value: properties.typeName }] : []),
    ...(properties.container ? [{ name: 'Located in', value: properties.container }] : []),
    ...properties.attributes,
  ]
  return [
    { key: 'element', title: 'Element', badge: null, origin: 'ifc', rows: element },
    ...properties.groups.map((g, i) => ({
      key: `group-${i}`,
      title: g.name,
      badge: g.source === 'type' ? 'Type' : g.kind === 'quantities' ? 'Quantities' : null,
      origin: 'ifc' as const,
      rows: g.rows,
    })),
    ...(properties.systems.length > 0
      ? [{ key: 'systems', title: 'Systems', badge: null, origin: 'ifc' as const, rows: properties.systems.map((s) => ({ name: 'System', value: s })) }]
      : []),
    ...(properties.ports.length > 0 ? [{ key: 'ports', title: 'Connections', badge: null, origin: 'ifc' as const, rows: properties.ports }] : []),
  ]
}

/** A bare number gets its unit spelled out; Revit's own formatting ("0' - 6\"", "120 V") is left as it is. */
function withUnit(value: string, unit: string | null): string {
  return unit && /^-?[\d.,]+$/.test(value) ? `${value} ${unit}` : value
}

/** Revit's parameter groups: the element's own (instance) first, then its type's; empty parameters only when asked. */
export function revitSections(parameters: RevitElementParameters, showEmpty: boolean): Section[] {
  const counters = { instance: 0, type: 0 }
  return parameters.groups.flatMap((g) => {
    const index = counters[g.source]++
    const rows = g.parameters.filter((p) => showEmpty || !p.empty).map((p) => ({ name: p.name, value: withUnit(p.value, p.unit) }))
    if (rows.length === 0) return []
    return [{ key: `revit-${g.source}-${index}`, title: g.name, badge: g.source === 'type' ? 'Type' : 'Instance', origin: 'revit' as const, rows }]
  })
}

export function emptyRevitCount(parameters: RevitElementParameters): number {
  return parameters.groups.reduce((n, g) => n + g.parameters.filter((p) => p.empty).length, 0)
}

/** Sections narrowed to rows whose name or value contains the query (case-insensitive); empty sections drop out. */
export function filterSections(sections: readonly Section[], query: string): Section[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...sections]
  return sections
    .map((s) => (s.title.toLowerCase().includes(q) ? s : { ...s, rows: s.rows.filter((r) => `${r.name} ${r.value}`.toLowerCase().includes(q)) }))
    .filter((s) => s.rows.length > 0)
}

function SectionList({ sections, open, onOpenChange, filtering }: { sections: readonly Section[]; open: string[]; onOpenChange: (v: string[]) => void; filtering: boolean }) {
  return (
    <Accordion type="multiple" value={filtering ? sections.map((s) => s.key) : open} onValueChange={(value) => !filtering && onOpenChange(value)}>
      {sections.map((section) => (
        <AccordionItem key={section.key} value={section.key}>
          <AccordionTrigger className="py-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{section.title}</span>
              {section.badge && (
                <Badge variant={section.badge === 'Type' ? 'secondary' : 'outline'} className="text-[10px]">
                  {section.badge}
                </Badge>
              )}
              <span className="text-muted-foreground">{section.rows.length}</span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <ItemGroup className="gap-1">
              {section.rows.map((row, i) => (
                <Item key={`${row.name}-${i}`} size="sm">
                  <ItemContent>
                    <ItemDescription className="text-xs">{row.name}</ItemDescription>
                    <ItemTitle className="text-xs font-normal break-all">{row.value || '—'}</ItemTitle>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}

function SourceHeading({ children, detail }: { children: string; detail?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-2 pt-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</span>
      {detail && <span className="text-[10px] text-muted-foreground">{detail}</span>}
    </div>
  )
}

function exportedLabel(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : `exported ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

export function LinkedElementProperties({
  referenceLabel,
  properties,
  problem,
  revit = null,
  unplaced = null,
}: {
  referenceLabel: string
  properties: ReferenceItemProperties | null
  problem: string | null
  /** Revit's own parameters for this element; null when the reference has none to offer. */
  revit?: RevitState | null
  /** Set when the element isn't in the IFC and was picked from its symbol. */
  unplaced?: UnplacedElementView | null
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string[]>(['element', 'group-0', 'revit-instance-0'])
  const [showEmpty, setShowEmpty] = useState(false)
  const revitData = revit?.status === 'ready' ? revit.parameters : null
  const ifcSections = useMemo(() => (properties ? propertySections(properties) : []), [properties])
  const fromRevit = useMemo(() => (revitData ? revitSections(revitData, showEmpty) : []), [revitData, showEmpty])
  const visibleRevit = useMemo(() => filterSections(fromRevit, query), [fromRevit, query])
  const visibleIfc = useMemo(() => filterSections(ifcSections, query), [ifcSections, query])
  const filtering = query.trim().length > 0
  const hasIfcPsets = (properties?.groups.length ?? 0) > 0
  const emptyCount = revitData ? emptyRevitCount(revitData) : 0
  const canFilter = properties !== null || revitData !== null
  const name = revitData?.element.name ?? properties?.name ?? unplaced?.name ?? 'Linked element'
  const noRevitAnywhere = !revitData && revit?.status !== 'loading' && revit?.status !== 'error'

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium break-all">{name}</span>
        <span className="text-xs text-muted-foreground">{referenceLabel} · read only</span>
      </div>

      {unplaced && (
        <Alert>
          <MapPin />
          <AlertTitle>No 3D shape in the model</AlertTitle>
          <AlertDescription>
            Revit draws this {unplaced.category?.toLowerCase().replace(/s$/, '') ?? 'device'} as a plan symbol, so the IFC file leaves it out. The symbol sits where Revit places it
            {unplaced.level ? ` on ${unplaced.level}` : ''}.
          </AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Properties unavailable</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}

      {revit?.status === 'loading' && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner />
          Loading Revit parameters…
        </div>
      )}

      {revit?.status === 'error' && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Revit parameters unavailable</AlertTitle>
          <AlertDescription>{revit.message}</AlertDescription>
        </Alert>
      )}

      {noRevitAnywhere && !hasIfcPsets && (properties || unplaced) && (
        <Empty className="border p-4">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListX />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No Revit parameters on this element</EmptyTitle>
            <EmptyDescription className="text-xs">
              {revit?.status === 'unavailable'
                ? revit.message
                : 'This linked model was exported without its Revit parameters. Export it again from Revit to see type and instance values here.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {noRevitAnywhere && hasIfcPsets && revit?.status === 'unavailable' && <p className="text-xs text-muted-foreground">{revit.message}</p>}

      {canFilter && (
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter properties" aria-label="Filter properties" className="h-8 text-xs" />
      )}

      {canFilter && filtering && visibleRevit.length === 0 && visibleIfc.length === 0 && (
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground" role="status">
          <span>No properties match “{query.trim()}”.</span>
          <Button variant="ghost" size="sm" onClick={() => setQuery('')}>
            Clear filter
          </Button>
        </div>
      )}

      {revitData && (visibleRevit.length > 0 || !filtering) && (
        <div className="flex flex-col gap-1" data-testid="revit-parameters">
          <SourceHeading detail={exportedLabel(revitData.exportedAt)}>From Revit</SourceHeading>
          <SectionList sections={visibleRevit} open={open} onOpenChange={setOpen} filtering={filtering} />
          {emptyCount > 0 && (
            <Button variant="ghost" size="sm" className="self-start text-xs" onClick={() => setShowEmpty((v) => !v)} aria-pressed={showEmpty}>
              {showEmpty ? 'Hide parameters with no value' : `Show ${emptyCount} parameter${emptyCount === 1 ? '' : 's'} with no value`}
            </Button>
          )}
        </div>
      )}

      {visibleIfc.length > 0 && (
        <div className="flex flex-col gap-1">
          {revitData && <SourceHeading>From the IFC file</SourceHeading>}
          <SectionList sections={visibleIfc} open={open} onOpenChange={setOpen} filtering={filtering} />
        </div>
      )}
    </>
  )
}
