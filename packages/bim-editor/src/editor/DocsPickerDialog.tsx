'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Box, ChevronDown, ChevronRight, Cloud, FileBox, FileX, Folder, FolderOpen, Search, X } from 'lucide-react'
import { Alert, AlertDescription } from '../ui/alert'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty'
import { Field, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '../ui/item'
import { ScrollArea } from '../ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Spinner } from '../ui/spinner'
import type { PackSet } from '@permitzip/bim-kernel/packs'
import { LinkedDisciplineSelectItems } from './linked-display/LinkedDisciplineSelectItems'
import { LinkedContributorFields } from './linked-display/LinkedDisciplinesField'
import {
  isLinkedDiscipline,
  linkedDisciplineChoices,
  linkedDisciplineLabel,
  MAX_LINKED_DISCIPLINES,
  formatBytes,
  guessDiscipline,
  type DocsBrowseResponse,
  type DocsFileKind,
  type DocsFileView,
  type DocsFolderView,
  type LinkedDiscipline,
} from '../contracts/building-model/linked-contract'
import { useEditorHost } from '@permitzip/bim-editor/host'
import { addDocsItemsFrom, browseDocsFrom } from './linked-api'

interface Props {
  projectId: string
  open: boolean
  onOpenChange(open: boolean): void
  /** The connected Revit model, whose Autodesk Docs project is browsed. */
  revitModelName: string | null
  /** Called after files were queued, so the panel shows their progress now. */
  onQueued(): void
  /** The open model's discipline registry (its add-ons and firm rows); built-in and first-party when absent. */
  disciplineSet?: PackSet
}

const ROOT = '__root__'
const MAX_PICK = 25
type Loaded = { status: 'loading' } | { status: 'error'; message: string } | { status: 'loaded'; data: DocsBrowseResponse }

interface Picked {
  readonly file: DocsFileView
  readonly label: string
  readonly discipline: LinkedDiscipline
  /** Other disciplines the same file shows (one firm's model may carry several). */
  readonly more: readonly LinkedDiscipline[]
}

const KIND_LABEL: Readonly<Record<DocsFileKind, string>> = { rvt: 'Revit', ifc: 'IFC', nwc: 'Navisworks', other: 'File' }

function FileIcon({ kind }: { kind: DocsFileKind }) {
  if (kind === 'rvt') return <FileBox className="text-primary" aria-hidden />
  if (kind === 'ifc') return <Box className="text-primary" aria-hidden />
  return <FileX className="text-muted-foreground" aria-hidden />
}

const stripExtension = (name: string) => name.replace(/\.[a-z0-9]+$/i, '')

export function DocsPickerDialog({ projectId, open, onOpenChange, revitModelName, onQueued, disciplineSet }: Props) {
  const linked = useEditorHost().data.linkedModels
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [current, setCurrent] = useState<string | null>(null)
  const [queryText, setQueryText] = useState('')
  const [search, setSearch] = useState<{ query: string; scope: string | null; result: Loaded } | null>(null)
  const [picked, setPicked] = useState<ReadonlyMap<string, Picked>>(new Map())
  const [contributor, setContributor] = useState({ organization: '', contact: '' })
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (folderId: string | null) => {
      const key = folderId ?? ROOT
      setLoaded((prev) => ({ ...prev, [key]: { status: 'loading' } }))
      try {
        const data = await browseDocsFrom(linked, projectId, { folderId })
        setLoaded((prev) => ({ ...prev, [key]: { status: 'loaded', data } }))
        setNames((prev) => ({ ...prev, ...Object.fromEntries(data.folders.map((f) => [f.id, f.name])) }))
        return data
      } catch (err) {
        console.error('[DocsPickerDialog] browsing Autodesk Docs failed', { folderId, err })
        setLoaded((prev) => ({ ...prev, [key]: { status: 'error', message: err instanceof Error ? err.message : "Couldn't open Autodesk Docs." } }))
        return null
      }
    },
    [linked, projectId],
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void load(null).then((root) => {
      if (cancelled || !root) return
      const start = root.folders.find((f) => /^project files$/i.test(f.name)) ?? root.folders[0]
      if (!start) return
      setCurrent(start.id)
      setExpanded(new Set([start.id]))
      void load(start.id)
    })
    return () => {
      cancelled = true
    }
  }, [open, load])

  function openFolder(folder: DocsFolderView) {
    setCurrent(folder.id)
    setSearch(null)
    setExpanded((prev) => new Set(prev).add(folder.id))
    if (!loaded[folder.id] || loaded[folder.id]?.status === 'error') void load(folder.id)
  }

  function toggleFolder(folder: DocsFolderView) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(folder.id)) next.delete(folder.id)
      else next.add(folder.id)
      return next
    })
    if (!loaded[folder.id]) void load(folder.id)
  }

  async function runSearch() {
    const query = queryText.trim()
    if (!query) {
      setSearch(null)
      return
    }
    const scope = current
    setSearch({ query, scope, result: { status: 'loading' } })
    try {
      const data = await browseDocsFrom(linked, projectId, { folderId: scope, query })
      setSearch((prev) => (prev && prev.query === query ? { query, scope, result: { status: 'loaded', data } } : prev))
    } catch (err) {
      console.error('[DocsPickerDialog] searching Autodesk Docs failed', { query, err })
      setSearch((prev) => (prev && prev.query === query ? { query, scope, result: { status: 'error', message: err instanceof Error ? err.message : 'The search failed.' } } : prev))
    }
  }

  function togglePick(file: DocsFileView, on: boolean) {
    setPicked((prev) => {
      const next = new Map(prev)
      if (!on) next.delete(file.itemId)
      else if (next.size < MAX_PICK) next.set(file.itemId, { file, label: file.linked?.label ?? stripExtension(file.name), discipline: guessDiscipline(file.name), more: [] })
      return next
    })
  }

  function updatePick(itemId: string, patch: Partial<Pick<Picked, 'label' | 'discipline' | 'more'>>) {
    setPicked((prev) => {
      const entry = prev.get(itemId)
      if (!entry) return prev
      return new Map(prev).set(itemId, { ...entry, ...patch })
    })
  }

  async function add() {
    setError(null)
    setAdding(true)
    try {
      const company = { organization: contributor.organization.trim(), contact: contributor.contact.trim() }
      const items = [...picked.values()].map((p) => ({
        itemId: p.file.itemId,
        label: p.label.trim(),
        discipline: p.discipline,
        ...(p.more.length > 0 ? { disciplines: [p.discipline, ...p.more.filter((d) => d !== p.discipline)] } : {}),
        ...(company.organization || company.contact ? { contributor: company } : {}),
      }))
      const results = await addDocsItemsFrom(linked, projectId, items)
      const queued = results.filter((r) => r.outcome === 'queued').length
      const running = results.length - queued
      toast.success(
        `${queued} ${queued === 1 ? 'model is' : 'models are'} coming in from Autodesk Docs. Each shows its progress under Linked models.` +
          (running > 0 ? ` ${running} ${running === 1 ? 'was' : 'were'} already on the way.` : ''),
      )
      onQueued()
      setPicked(new Map())
      onOpenChange(false)
    } catch (err) {
      console.error('[DocsPickerDialog] adding models failed', err)
      setError(err instanceof Error ? err.message : "The models weren't added.")
    } finally {
      setAdding(false)
    }
  }

  const shown: Loaded | undefined = search ? search.result : current ? loaded[current] : undefined
  const root = loaded[ROOT]
  const pickedList = useMemo(() => [...picked.values()], [picked])
  const badLabel = pickedList.some((p) => p.label.trim().length === 0)
  const addBlockedReason = pickedList.length === 0 ? 'Pick at least one Revit or IFC file' : badLabel ? 'Give every model a name' : null

  function renderTree(folders: readonly DocsFolderView[], depth: number) {
    return folders.map((folder) => {
      const isOpen = expanded.has(folder.id)
      const children = loaded[folder.id]
      return (
        <div key={folder.id} className="flex flex-col">
          <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
            <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={isOpen ? `Collapse ${folder.name}` : `Expand ${folder.name}`} onClick={() => toggleFolder(folder)}>
              {isOpen ? <ChevronDown /> : <ChevronRight />}
            </Button>
            <Button
              variant={current === folder.id && !search ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 min-w-0 flex-1 justify-start px-1.5 font-normal"
              onClick={() => openFolder(folder)}
              data-testid="docs-folder"
            >
              {current === folder.id ? <FolderOpen data-icon="inline-start" /> : <Folder data-icon="inline-start" />}
              <span className="truncate">{folder.name}</span>
            </Button>
          </div>
          {isOpen && children?.status === 'loading' && (
            <span className="flex items-center gap-1 py-1 text-xs text-muted-foreground" style={{ paddingLeft: depth * 12 + 30 }}>
              <Spinner className="size-3" /> Opening…
            </span>
          )}
          {isOpen && children?.status === 'error' && (
            <span className="py-1 text-xs text-destructive" style={{ paddingLeft: depth * 12 + 30 }}>
              {children.message}
            </span>
          )}
          {isOpen && children?.status === 'loaded' && renderTree(children.data.folders, depth + 1)}
        </div>
      )
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !adding && onOpenChange(next)}>
      <DialogContent className="sm:max-w-4xl" data-testid="docs-picker-dialog">
        <DialogHeader>
          <DialogTitle>Add models from Autodesk Docs</DialogTitle>
          <DialogDescription>
            Pick Revit or IFC files in {revitModelName ? `the Autodesk Docs project of ${revitModelName}` : "this project's Autodesk Docs project"}, such as the
            architect&apos;s model. Each comes in as its own linked model. Revit files are opened read-only; nothing in Docs or Revit changes.
          </DialogDescription>
        </DialogHeader>

        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            placeholder={current && names[current] ? `Search in ${names[current]}` : 'Search all folders'}
            aria-label="Search Autodesk Docs by file name"
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void runSearch()
              }
            }}
            maxLength={100}
          />
          <InputGroupAddon align="inline-end">
            {search ? (
              <InputGroupButton
                aria-label="Clear the search"
                onClick={() => {
                  setSearch(null)
                  setQueryText('')
                }}
              >
                <X />
              </InputGroupButton>
            ) : (
              <InputGroupButton onClick={() => void runSearch()} disabled={!queryText.trim()}>
                Search
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>

        <div className="grid min-h-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <ScrollArea className="h-72 rounded-md border p-1" aria-label="Folders">
            {(!root || root.status === 'loading') && (
              <span className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                <Spinner className="size-3" /> Opening Autodesk Docs…
              </span>
            )}
            {root?.status === 'error' && (
              <Alert variant="destructive" className="m-1">
                <AlertDescription className="text-xs">
                  {root.message}{' '}
                  <Button variant="link" size="sm" className="h-auto p-0" onClick={() => void load(null)}>
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {root?.status === 'loaded' && root.data.folders.length === 0 && <span className="block p-2 text-xs text-muted-foreground">No folders you can open.</span>}
            {root?.status === 'loaded' && renderTree(root.data.folders, 0)}
          </ScrollArea>

          <ScrollArea className="h-72 rounded-md border p-1" aria-label="Files">
            {search && (
              <span className="block px-2 pb-1 text-xs text-muted-foreground">
                Files named like “{search.query}” {search.scope && names[search.scope] ? `in ${names[search.scope]} and below` : 'in every folder'}
              </span>
            )}
            {!shown && <span className="block p-2 text-xs text-muted-foreground">Open a folder to see its Revit and IFC files.</span>}
            {shown?.status === 'loading' && (
              <span className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                <Spinner className="size-3" /> {search ? 'Searching…' : 'Opening the folder…'}
              </span>
            )}
            {shown?.status === 'error' && (
              <Alert variant="destructive" className="m-1">
                <AlertDescription className="text-xs">{shown.message}</AlertDescription>
              </Alert>
            )}
            {shown?.status === 'loaded' && shown.data.files.length === 0 && (
              <Empty className="py-6">
                <EmptyHeader>
                  <EmptyTitle className="text-sm">{search ? 'No Revit or IFC files match' : 'No Revit or IFC files here'}</EmptyTitle>
                  <EmptyDescription className="text-xs">{search ? 'Try part of the file name, or search a higher folder.' : 'Open a subfolder on the left, or search.'}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            {shown?.status === 'loaded' && shown.data.files.length > 0 && (
              <ItemGroup className="gap-1">
                {shown.data.files.map((file) => {
                  const isPicked = picked.has(file.itemId)
                  const full = !isPicked && picked.size >= MAX_PICK
                  const disabledReason = file.blockedReason ?? (full ? `You can add up to ${MAX_PICK} at a time.` : null)
                  return (
                    <Item key={file.itemId} size="xs" variant={isPicked ? 'muted' : 'default'} data-testid="docs-file" data-blocked={file.blockedReason ? 'true' : 'false'}>
                      <ItemMedia>
                        <Checkbox
                          checked={isPicked}
                          disabled={disabledReason !== null && !isPicked}
                          onCheckedChange={(checked) => togglePick(file, checked === true)}
                          aria-label={`Add ${file.name}`}
                        />
                      </ItemMedia>
                      <ItemMedia variant="icon">
                        <FileIcon kind={file.kind} />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle className="text-xs">{file.name}</ItemTitle>
                        <ItemDescription className="text-xs">
                          {KIND_LABEL[file.kind]}
                          {file.versionNumber !== null ? ` · version ${file.versionNumber}` : ''}
                          {file.bytes !== null ? ` · ${formatBytes(file.bytes)}` : ''}
                          {file.lastModified ? ` · ${new Date(file.lastModified).toLocaleDateString()}` : ''}
                          {disabledReason && !isPicked && <span className="block">{disabledReason}</span>}
                          {file.linked && <span className="block">Already linked as {file.linked.label}. Adding it again brings in its newest version.</span>}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        {file.revitYear !== null && (
                          <Badge variant="outline" className="text-[10px]" data-testid="docs-file-revit-year">
                            Revit {file.revitYear}
                          </Badge>
                        )}
                        {file.isCloudModel && (
                          <Badge variant="outline" className="text-[10px]">
                            <Cloud data-icon="inline-start" />
                            Cloud model
                          </Badge>
                        )}
                        {file.linked && (
                          <Badge variant="secondary" className="text-[10px]">
                            Linked
                          </Badge>
                        )}
                      </ItemActions>
                    </Item>
                  )
                })}
              </ItemGroup>
            )}
          </ScrollArea>
        </div>

        {pickedList.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="docs-picked">
            <span className="text-sm font-medium">
              {pickedList.length} picked · name each one and say what it shows
            </span>
            <ScrollArea className="max-h-40">
              <div className="flex flex-col gap-2 pr-2">
                {pickedList.map((p) => (
                  <div key={p.file.itemId} className="grid grid-cols-[minmax(0,1fr)_10rem_auto] items-end gap-2">
                    <Field>
                      <FieldLabel htmlFor={`docs-label-${p.file.itemId}`} className="truncate text-xs">
                        {p.file.name}
                      </FieldLabel>
                      <Input
                        id={`docs-label-${p.file.itemId}`}
                        value={p.label}
                        maxLength={200}
                        aria-invalid={p.label.trim().length === 0 ? true : undefined}
                        disabled={p.file.linked !== null}
                        title={p.file.linked ? 'Already linked: the new version keeps its name' : undefined}
                        onChange={(e) => updatePick(p.file.itemId, { label: e.target.value })}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`docs-discipline-${p.file.itemId}`} className="text-xs">
                        Shows
                      </FieldLabel>
                      <Select
                        value={p.discipline}
                        disabled={p.file.linked !== null}
                        onValueChange={(v) => isLinkedDiscipline(v) && updatePick(p.file.itemId, { discipline: v, more: p.more.filter((d) => d !== v) })}
                      >
                        <SelectTrigger id={`docs-discipline-${p.file.itemId}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <LinkedDisciplineSelectItems set={disciplineSet} current={p.discipline} />
                        </SelectContent>
                      </Select>
                    </Field>
                    <Button variant="ghost" size="icon" aria-label={`Don't add ${p.file.name}`} onClick={() => togglePick(p.file, false)}>
                      <X />
                    </Button>
                    {p.file.linked === null && <AlsoShows pick={p} set={disciplineSet} onChange={(more) => updatePick(p.file.itemId, { more })} />}
                  </div>
                ))}
              </div>
            </ScrollArea>
            <LinkedContributorFields id="docs-contributor" organization={contributor.organization} contact={contributor.contact} onChange={setContributor} disabled={adding} />
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adding}>
            Cancel
          </Button>
          <Button onClick={() => void add()} disabled={adding || addBlockedReason !== null} title={addBlockedReason ?? undefined} data-testid="docs-add">
            {adding && <Spinner data-icon="inline-start" />}
            {addBlockedReason ?? `Add ${pickedList.length} ${pickedList.length === 1 ? 'model' : 'models'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The other disciplines one picked file shows, as chips with Remove, and a picker to add one. */
function AlsoShows({ pick, set, onChange }: { readonly pick: Picked; readonly set?: PackSet; readonly onChange: (more: readonly LinkedDiscipline[]) => void }) {
  const left = linkedDisciplineChoices(set).filter((c) => c.value !== pick.discipline && !pick.more.includes(c.value))
  const blocked = pick.more.length + 1 >= MAX_LINKED_DISCIPLINES ? `Up to ${MAX_LINKED_DISCIPLINES} disciplines per model.` : left.length === 0 ? 'Every discipline is already picked.' : null
  return (
    <div className="col-span-3 flex flex-wrap items-center gap-1.5" data-testid={`docs-also-${pick.file.itemId}`}>
      {pick.more.map((d) => {
        const label = linkedDisciplineLabel(d, set)
        return (
          <Badge key={d} variant="secondary" className="gap-1 pr-0.5">
            {label}
            <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${label} from ${pick.file.name}`} onClick={() => onChange(pick.more.filter((x) => x !== d))}>
              <X />
            </Button>
          </Badge>
        )
      })}
      <Select value="" onValueChange={(v) => isLinkedDiscipline(v) && onChange([...pick.more, v])} disabled={blocked !== null}>
        <SelectTrigger size="sm" className="h-7 w-auto text-xs" aria-label={`Also shows, for ${pick.file.name}`} title={blocked ?? undefined}>
          <SelectValue placeholder={blocked ?? 'Also shows…'} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {left.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}
