'use client'

import { useMemo, useState } from 'react'
import { Building2, Layers, Plus, Search, X } from 'lucide-react'
import type { Level } from '@permitzip/bim-kernel'
import { Button } from '../ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '../ui/input-group'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Separator } from '../ui/separator'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { Spinner } from '../ui/spinner'
import type { CatalogEntry } from './model-session'
import type { FirmLibraryStatus } from './part-editor/use-firm-part-library'
import { GroupedPartsList } from './parts-list/GroupedPartsList'
import { MM_PER_FT } from './placement'

interface Props {
  catalog: readonly CatalogEntry[]
  levels: readonly Level[]
  selectedTypeId: string | null
  onSelectType: (entry: CatalogEntry) => void
  levelId: string | null
  onLevel: (levelId: string) => void
  heightFt: string
  onHeight: (value: string) => void
  onAddLevel: (name: string, elevationMm: number) => string | null
  onStop: () => void
  /** Open the part editor on a blank part. Absent when this person can't change the model. */
  onNewPart?: () => void
  /** Open the part editor on a modeled part type. */
  onEditPart?: (entry: CatalogEntry) => void
  /** Make the levels from the architect's linked model (absent: no such offer here). */
  onUseArchitectLevels?: () => void
  /** The firm library's parts are in `catalog` once it has loaded. */
  firmLibrary?: { status: FirmLibraryStatus; retry: () => void }
}

/** Left panel while the Place part tool is on: pick a type (any discipline), a level and a height, then click in the view. */
export function PartsPanel({ catalog, levels, selectedTypeId, onSelectType, levelId, onLevel, heightFt, onHeight, onAddLevel, onStop, onNewPart, onEditPart, onUseArchitectLevels, firmLibrary }: Props) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const categories = useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of catalog) seen.set(e.definition.category, e.categoryLabel)
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [catalog])
  const inCategory = useMemo(() => (category === 'all' ? catalog : catalog.filter((e) => e.definition.category === category)), [catalog, category])

  return (
    <div className="flex flex-col gap-3" data-testid="parts-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Place a part</span>
        <div className="flex items-center gap-1">
          {onNewPart && (
            <Button variant="outline" size="sm" onClick={onNewPart} data-testid="new-part">
              <Plus data-icon="inline-start" />
              New part
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Stop placing" onClick={onStop}>
            <X />
          </Button>
        </div>
      </div>
      {levels.length === 0 ? (
        <AddLevel onAddLevel={onAddLevel} onUseArchitectLevels={onUseArchitectLevels} />
      ) : (
        <FieldGroup className="grid grid-cols-2 gap-2">
          <Field>
            <FieldLabel htmlFor="bm-place-level">Level</FieldLabel>
            <Select value={levelId ?? undefined} onValueChange={onLevel}>
              <SelectTrigger id="bm-place-level" size="sm">
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {levels.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="bm-place-height">Height (ft)</FieldLabel>
            <Input id="bm-place-height" inputMode="decimal" value={heightFt} onChange={(e) => onHeight(e.target.value)} />
          </Field>
        </FieldGroup>
      )}
      <Separator />
      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput placeholder="Search parts" aria-label="Search parts" value={search} onChange={(e) => setSearch(e.target.value)} />
      </InputGroup>
      <Select value={category} onValueChange={setCategory}>
        <SelectTrigger size="sm" aria-label="Category">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {firmLibrary?.status.state === 'loading' && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> Loading the firm library…
        </p>
      )}
      {firmLibrary?.status.state === 'failed' && (
        <Alert variant="destructive" data-testid="firm-library-failed">
          <AlertTitle>The firm library didn’t load</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {firmLibrary.status.message}. Project and starter parts are still here.
            <Button size="sm" variant="outline" onClick={firmLibrary.retry}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <GroupedPartsList entries={inCategory} filter={search} onClearFilter={() => setSearch('')} selectedTypeId={selectedTypeId} onSelectType={onSelectType} onEditPart={onEditPart} />
    </div>
  )
}

/** No level yet: add one here, or take the architect's, so the tool beside it can act. Shared by Place part and Route. */
export function AddLevel({
  onAddLevel,
  onUseArchitectLevels,
  what = 'Parts',
  idPrefix = 'bm-level',
}: {
  onAddLevel: (name: string, elevationMm: number) => string | null
  onUseArchitectLevels?: () => void
  /** What sits on a level, for the description ("Routes"). */
  what?: string
  idPrefix?: string
}) {
  const [name, setName] = useState('Level 1')
  const [elevation, setElevation] = useState('0')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const ft = Number(elevation)
    if (name.trim() === '' || !Number.isFinite(ft)) {
      setError('Give the level a name and a floor elevation in feet.')
      return
    }
    setError(onAddLevel(name.trim(), ft * MM_PER_FT))
  }
  return (
    <Empty className="border p-3">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Layers />
        </EmptyMedia>
        <EmptyTitle>Add a level first</EmptyTitle>
        <EmptyDescription>{what} sit on a level. This model has none yet, so clicks in the view can&apos;t add anything.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {onUseArchitectLevels && (
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={onUseArchitectLevels} data-testid={`${idPrefix}-use-architect-levels`}>
            <Building2 data-icon="inline-start" />
            Use the architect&apos;s levels
          </Button>
        )}
        <form onSubmit={submit} className="flex w-full flex-col gap-2">
          <FieldGroup className="grid grid-cols-2 gap-2">
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-name`}>Name</FieldLabel>
              <Input id={`${idPrefix}-name`} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${idPrefix}-elev`}>Floor (ft)</FieldLabel>
              <Input id={`${idPrefix}-elev`} inputMode="decimal" value={elevation} onChange={(e) => setElevation(e.target.value)} />
            </Field>
          </FieldGroup>
          {error && (
            <FieldDescription className="text-danger-600" role="alert">
              {error}
            </FieldDescription>
          )}
          <Button type="submit" size="sm" data-testid={`${idPrefix}-add`}>
            <Plus data-icon="inline-start" />
            Add level
          </Button>
        </form>
      </EmptyContent>
    </Empty>
  )
}
