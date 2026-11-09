'use client'

import { useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import { convertParametersExport, type ConvertResult, type RevitParametersExport } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { SettingsCard } from '../../ui/settings-page'
import { ConnectorReport } from '../part-editor/ConnectorReport'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { unavailableWords } from '@permitzip/bim-editor/host/unavailable'

type Converted = Extract<ConvertResult, { ok: true }>
type Failed = Extract<ConvertResult, { ok: false }>
type SaveState = { readonly kind: 'idle' } | { readonly kind: 'saving' } | { readonly kind: 'saved' } | { readonly kind: 'error'; readonly message: string }

type ReadState =
  | { readonly kind: 'empty' }
  | { readonly kind: 'reading'; readonly fileName: string }
  | { readonly kind: 'read'; readonly fileName: string; readonly converted: readonly Converted[]; readonly failed: readonly Failed[] }
  | { readonly kind: 'error'; readonly fileName: string; readonly message: string }

function isParametersExport(value: unknown): value is RevitParametersExport {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'schema') === 'string'
}

type LibraryPort = EditorDataHost['firmLibrary']

/** Save one imported part type to the firm library; null when saved, else the refusal in words. */
export async function saveImportedPartTypeFrom(port: LibraryPort, definition: Converted['definition']): Promise<string | null> {
  if (!port) return unavailableWords('Saving to the firm library')
  const res = await port.importPartType({ definition })
  if (res.ok) return null
  const body: unknown = await res.json().catch((err: unknown) => {
    console.error('[PartImportSection] error body unreadable', err)
    return null
  })
  const message = typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : null
  return typeof message === 'string' ? message : `HTTP ${res.status}`
}

/**
 * Settings › MutinyBIM library › Import part types (round 9 J9): read a
 * Revit parameter export, show every type's connector report before it is
 * saved, and save each to the firm library. A type with bad connectors still
 * saves; the problems show as issues wherever it is placed.
 */
export function PartImportSectionFrom({ port, canSave, save: given }: { readonly port: LibraryPort; readonly canSave: boolean; readonly save?: (definition: Converted['definition']) => Promise<string | null> }) {
  const save = given ?? ((definition: Converted['definition']) => saveImportedPartTypeFrom(port, definition))
  const input = useRef<HTMLInputElement>(null)
  const [read, setRead] = useState<ReadState>({ kind: 'empty' })
  const [saves, setSaves] = useState<Readonly<Record<string, SaveState>>>({})

  const onFile = async (file: File) => {
    setRead({ kind: 'reading', fileName: file.name })
    setSaves({})
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isParametersExport(parsed)) throw new Error('it is not a Revit parameter export (no "schema" field)')
      const results = convertParametersExport(parsed, { origin: file.name })
      setRead({ kind: 'read', fileName: file.name, converted: results.filter((r): r is Converted => r.ok), failed: results.filter((r): r is Failed => !r.ok) })
    } catch (err) {
      console.error('[PartImportSection] the export could not be read', err)
      setRead({ kind: 'error', fileName: file.name, message: err instanceof Error ? err.message : 'the file could not be read' })
    }
  }

  const saveOne = async (r: Converted) => {
    setSaves((s) => ({ ...s, [r.id]: { kind: 'saving' } }))
    try {
      const refused = await save(r.definition)
      setSaves((s) => ({ ...s, [r.id]: refused ? { kind: 'error', message: refused } : { kind: 'saved' } }))
    } catch (err) {
      console.error('[PartImportSection] save failed', err)
      setSaves((s) => ({ ...s, [r.id]: { kind: 'error', message: err instanceof Error ? err.message : 'the save failed' } }))
    }
  }

  const choose = () => input.current?.click()
  const picker = (
    <Input
      ref={input}
      type="file"
      accept="application/json,.json"
      className="hidden"
      data-testid="part-import-file"
      onChange={(e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (file) void onFile(file)
      }}
    />
  )

  return (
    <SettingsCard
      id="part-import"
      title="Import part types"
      description="Bring in part types from a Revit parameter export. Each type's connector report shows before you save it, so a bad connector is fixed once in the library instead of on every project."
      actions={
        <Button variant="outline" onClick={choose} disabled={read.kind === 'reading'} data-testid="part-import-choose">
          <FileUp data-icon="inline-start" />
          {read.kind === 'empty' ? 'Choose an export' : 'Choose another export'}
        </Button>
      }
    >
      {picker}
      {read.kind === 'empty' ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileUp />
            </EmptyMedia>
            <EmptyTitle>No export read yet</EmptyTitle>
            <EmptyDescription>Choose the JSON file the Revit parameter export wrote. Nothing is saved until you save a type.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={choose}>Choose an export</Button>
          </EmptyContent>
        </Empty>
      ) : null}
      {read.kind === 'reading' ? <p className="text-muted-foreground text-sm" aria-busy="true">Reading {read.fileName}…</p> : null}
      {read.kind === 'error' ? (
        <Alert variant="destructive">
          <AlertTitle>{read.fileName} couldn&apos;t be read</AlertTitle>
          <AlertDescription>
            Nothing was imported: {read.message}. Export the types again from Revit and choose that file.
          </AlertDescription>
        </Alert>
      ) : null}
      {read.kind === 'read' ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm">
            {read.fileName}: {read.converted.length} part type{read.converted.length === 1 ? '' : 's'} ready to review
            {read.failed.length > 0 ? `, ${read.failed.length} that can't be imported` : ''}.
          </p>
          {read.converted.length === 0 && read.failed.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No part types in this export</EmptyTitle>
                <EmptyDescription>The file has no family types to bring in. Check that the export included the families you want.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {read.converted.map((r) => {
            const s = saves[r.id] ?? { kind: 'idle' }
            return (
              <section key={r.id} className="flex flex-col gap-2 rounded-lg border p-3" aria-label={`${r.definition.familyName} ${r.definition.typeName}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">
                    {r.definition.familyName} · {r.definition.typeName}
                  </div>
                  <div className="flex items-center gap-2">
                    {s.kind === 'saved' ? <Badge variant="secondary">Saved to the firm library</Badge> : null}
                    <Button
                      size="sm"
                      onClick={() => void saveOne(r)}
                      disabled={!canSave || s.kind === 'saving' || s.kind === 'saved'}
                      title={!canSave ? 'Only people who can edit the firm library can save part types' : s.kind === 'saved' ? 'Already saved' : undefined}
                      data-testid={`part-import-save-${r.id}`}
                    >
                      {s.kind === 'saving' ? 'Saving…' : r.report.problems.length > 0 ? 'Save with these problems' : 'Save to firm library'}
                    </Button>
                  </div>
                </div>
                {!canSave ? <p className="text-muted-foreground text-xs">Only people who can edit the firm library can save part types.</p> : null}
                {s.kind === 'error' ? <p className="text-destructive text-sm">Not saved: {s.message}. Try again.</p> : null}
                <ConnectorReport report={r.report} />
              </section>
            )
          })}
          {read.failed.length > 0 ? (
            <ItemGroup className="gap-1" aria-label="Types that can't be imported">
              {read.failed.map((f, i) => (
                <Item key={`${f.family}-${f.typeName}-${i}`} variant="muted" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {f.family} · {f.typeName}
                    </ItemTitle>
                    <ItemDescription>Can&apos;t be imported: {f.reason}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          ) : null}
        </div>
      ) : null}
    </SettingsCard>
  )
}
