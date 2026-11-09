'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, RotateCw, Search } from 'lucide-react'
import {
  LINE_WEIGHTS,
  SYSTEM_LINE_PATTERNS,
  SYSTEM_PATTERN_LABEL,
  buildCategoryRegistry,
  categoryLook,
  drawnCategories,
  isViewCategory,
  rawRegistryWords,
  type CategoryOverride,
  type CategoryRegistry,
  disciplineLabel,
  type LineWeight,
  type RegisteredCategory,
  type ServiceDef,
  type ViewElement,
  type ViewPropsPatch,
} from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { FieldDescription, FieldLegend, FieldSet } from '../../ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../../ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Spinner } from '../../ui/spinner'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { graphicsPatch, type GraphicsEdit } from './category-graphics-patch'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { useFirmClassCategoriesFrom } from './use-firm-class-categories'

const WEIGHT_LABEL: Record<LineWeight, string> = { thin: 'Thin', medium: 'Medium', wide: 'Wide', heavy: 'Heavy' }

const NEWER_GROUP = 'Other categories this view sets'
const GROUP_ORDER = ['Mechanical', 'Plumbing', 'Electrical', 'Fire protection', 'Architecture', 'Structure', 'Civil', 'General contracting', 'Systems', 'Firm library', 'General', 'Documentation', 'Drafting', NEWER_GROUP] as const

/** A category this view overrides that this release doesn't know (a newer peer's or a pack's): kept as stored, shown in its raw words. */
function unknownCategory(id: string): RegisteredCategory {
  return { id, label: rawRegistryWords(id), source: 'class' }
}

function groupOf(c: RegisteredCategory, known: boolean): string {
  if (!known) return NEWER_GROUP
  if (c.source === 'drafting') return 'Drafting'
  if (c.discipline) return disciplineLabel(c.discipline)
  if (c.source === 'service') return 'Systems'
  if (c.source === 'firm') return 'Firm library'
  return 'General'
}

interface Props {
  readonly view: ViewElement
  readonly canEdit: boolean
  readonly disabledHint?: string
  /** Sends `set_view_properties`; returns why it was refused, or null. */
  readonly onPatch: (patch: ViewPropsPatch, label: string) => string | null
  /** Service rows (the services registry) to list as Systems. */
  readonly services?: readonly ServiceDef[]
}

/**
 * Visibility/Graphics: every category the model can draw (the built-in
 * trades, electrical included, the firm's own classes, systems, drafting),
 * grouped by discipline, each with show, halftone, cut and beyond pens and
 * a line pattern. Personal display only changes this view; it prints as
 * the view says.
 */
export function CategoryGraphicsTable({ view, canEdit, disabledHint, onPatch, services }: Props) {
  const firm = useFirmClassCategoriesFrom(useEditorHost().data.firmLibrary)
  const firmClasses = firm.state === 'ready' ? firm.classes : null
  const categories = useMemo(() => buildCategoryRegistry({ ...(firmClasses ? { extraClasses: firmClasses } : {}), ...(services ? { services } : {}) }), [firmClasses, services])
  const [query, setQuery] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const viewDiscipline = view.props?.discipline
  const overrides = view.props?.categoryOverrides
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byGroup = new Map<string, RegisteredCategory[]>()
    const unknown = Object.keys(overrides ?? {}).filter((id) => categories.get(id) === undefined).map(unknownCategory)
    for (const c of [...drawnCategories(categories), ...unknown]) {
      if (q && !c.label.toLowerCase().includes(q)) continue
      const g = groupOf(c, categories.get(c.id) !== undefined)
      byGroup.set(g, [...(byGroup.get(g) ?? []), c])
    }
    const own = viewDiscipline ? disciplineLabel(viewDiscipline) : null
    // Known groups in their usual order, then any other registered discipline's (fire alarm, an add-on's), alphabetically.
    const known: readonly string[] = GROUP_ORDER
    const others = [...byGroup.keys()].filter((g) => !known.includes(g)).sort((a, b) => a.localeCompare(b))
    return [...GROUP_ORDER.filter((g) => byGroup.has(g)), ...others]
      .sort((a, b) => (a === own ? -1 : b === own ? 1 : 0))
      .map((g) => ({ name: g, rows: byGroup.get(g) ?? [] }))
  }, [categories, query, viewDiscipline, overrides])

  // The first group (the view's own discipline) starts open; a search opens every group it matches in.
  const [opened, setOpened] = useState<ReadonlySet<string> | null>(null)
  const searching = query.trim() !== ''
  const isOpen = (name: string, index: number) => searching || (opened ? opened.has(name) : index === 0)
  const toggle = (name: string, open: boolean) => {
    const next = new Set(opened ?? groups.slice(0, 1).map((g) => g.name))
    if (open) next.add(name)
    else next.delete(name)
    setOpened(next)
  }

  const edit = (c: RegisteredCategory, change: GraphicsEdit, label: string) => {
    setRefusal(onPatch(graphicsPatch(view, c.id, change, categories), label))
  }

  return (
    <FieldSet id="view-visibility-graphics" data-testid="view-visibility-graphics" className="scroll-mt-4">
      <FieldLegend variant="label">Visibility/Graphics</FieldLegend>
      <FieldDescription className="text-xs">Show, halftone and pens for each category in this view, the electrical trades and your firm&apos;s own classes included. A row that says Default follows the category above it.</FieldDescription>
      <InputGroup className="h-8">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a category" aria-label="Find a category" data-testid="graphics-search" />
      </InputGroup>
      {firm.state === 'loading' && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="graphics-firm-loading">
          <Spinner className="size-3" />
          Loading your firm&apos;s library classes…
        </p>
      )}
      {firm.state === 'error' && (
        <Alert data-testid="graphics-firm-error">
          <AlertTitle>Your firm&apos;s own classes couldn&apos;t be loaded</AlertTitle>
          <AlertDescription>
            <p>{firm.message}. The built-in categories below still work.</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={firm.retry}>
              <RotateCw data-icon="inline-start" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {refusal && (
        <Alert data-testid="graphics-refused">
          <AlertTitle>That change wasn&apos;t made</AlertTitle>
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      )}
      {groups.length === 0 ? (
        <Empty className="p-4" data-testid="graphics-empty">
          <EmptyHeader>
            <EmptyTitle>No category matches “{query.trim()}”</EmptyTitle>
            <EmptyDescription>Try part of the name, such as “light” or “pipe”.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        groups.map((g, i) => (
          <Collapsible key={g.name} open={isOpen(g.name, i)} onOpenChange={(open) => toggle(g.name, open)}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-start px-1 text-xs font-medium [&[data-state=open]>svg]:rotate-90" data-testid={`graphics-group-${g.name}`}>
                <ChevronRight data-icon="inline-start" />
                {g.name} ({g.rows.length})
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Table className="text-xs">
                <TableCaption className="sr-only">{g.name} categories: shown, halftone, cut pen, beyond pen and line pattern in this view</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-7 px-1">Category</TableHead>
                    <TableHead className="h-7 px-1 text-center">Show</TableHead>
                    <TableHead className="h-7 px-1 text-center">Halftone</TableHead>
                    <TableHead className="h-7 px-1">Cut</TableHead>
                    <TableHead className="h-7 px-1">Beyond</TableHead>
                    <TableHead className="h-7 px-1">Pattern</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.rows.map((c) => (
                    <CategoryRow key={c.id} view={view} category={c} categories={categories} canEdit={canEdit} disabledHint={disabledHint} onEdit={edit} />
                  ))}
                </TableBody>
              </Table>
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
    </FieldSet>
  )
}

function CategoryRow({ view, category: c, categories, canEdit, disabledHint, onEdit }: { view: ViewElement; category: RegisteredCategory; categories: CategoryRegistry; canEdit: boolean; disabledHint?: string; onEdit: (c: RegisteredCategory, change: GraphicsEdit, label: string) => void }) {
  const look = categoryLook(view, c.id, categories)
  const own: CategoryOverride = view.props?.categoryOverrides?.[c.id] ?? {}
  const legacyWeights = isViewCategory(c.id) ? view.props?.lineWeights?.[c.id] : undefined
  const parent = c.parent ? categories.get(c.parent)?.label : undefined
  const name = c.label.toLowerCase()
  const weightSelect = (kind: 'cut' | 'projection') => {
    const value = own.lineWeights?.[kind] ?? legacyWeights?.[kind] ?? 'default'
    const inherited = look.lineWeights[kind] ?? c.defaults?.lineWeights?.[kind]
    return (
      <Select value={value} disabled={!canEdit} onValueChange={(v) => onEdit(c, { field: kind, value: LINE_WEIGHTS.find((w) => w === v) ?? null }, `change the ${name} ${kind === 'cut' ? 'cut' : 'beyond'} pen`)}>
        <SelectTrigger size="sm" className="h-7 w-full text-xs" aria-label={`${c.label} ${kind === 'cut' ? 'cut' : 'beyond'} line weight`} title={disabledHint}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="default" className="text-xs">
              {inherited && value === 'default' ? `Default (${WEIGHT_LABEL[inherited]})` : 'Default'}
            </SelectItem>
            {LINE_WEIGHTS.map((w) => (
              <SelectItem key={w} value={w} className="text-xs">
                {WEIGHT_LABEL[w]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    )
  }
  const defaultPattern = c.defaults?.pattern ? SYSTEM_LINE_PATTERNS.find((p) => p === c.defaults?.pattern) : undefined
  return (
    <TableRow data-testid={`graphics-row-${c.id}`}>
      <TableCell className="px-1 py-1">
        <span className={c.parent ? 'pl-3 font-normal' : 'font-medium'}>{c.label}</span>
        {parent && <span className="block pl-3 text-[11px] text-muted-foreground">follows {parent}</span>}
      </TableCell>
      <TableCell className="px-1 py-1 text-center">
        <Checkbox aria-label={`Show ${name}`} checked={look.visible} disabled={!canEdit} title={disabledHint} onCheckedChange={(v) => onEdit(c, { field: 'visible', value: v === true }, `${v === true ? 'show' : 'hide'} ${name}`)} />
      </TableCell>
      <TableCell className="px-1 py-1 text-center">
        <Checkbox aria-label={`Halftone ${name}`} checked={look.halftone === true} disabled={!canEdit} title={disabledHint} onCheckedChange={(v) => onEdit(c, { field: 'halftone', value: v === true }, `${v === true ? 'halftone' : 'print in ink'} ${name}`)} />
      </TableCell>
      <TableCell className="px-1 py-1">{weightSelect('cut')}</TableCell>
      <TableCell className="px-1 py-1">{weightSelect('projection')}</TableCell>
      <TableCell className="px-1 py-1">
        <Select value={own.pattern ?? 'default'} disabled={!canEdit} onValueChange={(v) => onEdit(c, { field: 'pattern', value: v === 'default' ? null : v }, `change the ${name} line pattern`)}>
          <SelectTrigger size="sm" className="h-7 w-full text-xs" aria-label={`${c.label} line pattern`} title={disabledHint}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="default" className="text-xs">
                {defaultPattern ? `Default (${SYSTEM_PATTERN_LABEL[defaultPattern]})` : 'Default'}
              </SelectItem>
              {SYSTEM_LINE_PATTERNS.map((p) => (
                <SelectItem key={p} value={p} className="text-xs">
                  {SYSTEM_PATTERN_LABEL[p]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </TableCell>
    </TableRow>
  )
}
