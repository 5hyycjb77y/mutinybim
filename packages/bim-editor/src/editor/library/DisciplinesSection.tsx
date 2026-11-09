'use client'

import { useCallback, useEffect, useState } from 'react'
import { Layers } from 'lucide-react'
import { modelSetupOf, type DisciplineDef, type ListedDiscipline, type ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { SettingsCard, SettingsLoadError, SettingsLoading } from '../../ui/settings-page'
import type { EditorDataHost } from '@permitzip/bim-editor-host'
import { EditorServiceUnavailableError } from '@permitzip/bim-editor/host/unavailable'

/** A firm discipline as the library lists it (`GET /api/bim/library?scope=firm&type=discipline`). */
export interface FirmDisciplineSummary {
  readonly key: string
  readonly name: string
  readonly deprecated: boolean
  /** The row a model pins (the API sends it for discipline listings). */
  readonly row?: DisciplineDef
}

/** A model to pin firm disciplines to (Building Model › Manage › Model settings › Add-ons). */
export interface DisciplinePinTarget {
  readonly model: ModelState
  readonly canEdit: boolean
  readonly blockedReason: string
  /** Sends one edit with its undo label; returns the refusal, or null when it was sent. */
  readonly submit: (command: { readonly type: 'pin_firm_discipline'; readonly discipline: DisciplineDef } | { readonly type: 'unpin_firm_discipline'; readonly disciplineId: string }, undoLabel: string) => string | null
}

export interface DisciplineRows {
  readonly registered: readonly ListedDiscipline[]
  readonly firm: readonly FirmDisciplineSummary[]
}

type LoadState = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly rows: DisciplineRows } | { readonly kind: 'error'; readonly message: string }

function isDisciplineRow(value: unknown): value is DisciplineDef {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && 'label' in value && typeof value.label === 'string' && 'display' in value && typeof value.display === 'object' && value.display !== null
}

function isFirmSummary(value: unknown): value is FirmDisciplineSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof value.key === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'deprecated' in value &&
    typeof value.deprecated === 'boolean' &&
    (!('row' in value) || value.row === undefined || isDisciplineRow(value.row))
  )
}

type LibraryPort = EditorDataHost['firmLibrary']

async function loadFirmDisciplines(port: LibraryPort): Promise<readonly FirmDisciplineSummary[]> {
  if (!port) throw new EditorServiceUnavailableError("The firm's disciplines")
  const res = await port.listOfType({ scope: 'firm', type: 'discipline' })
  if (!res.ok) throw new Error(`the firm library answered ${res.status}`)
  const body: unknown = await res.json()
  const items = typeof body === 'object' && body !== null && 'items' in body && Array.isArray(body.items) ? body.items : null
  if (!items) throw new Error('the firm library sent no item list')
  return items.filter(isFirmSummary)
}

/** Built-in and add-on rows from the kernel (loaded on their own, like the add-on list), and the firm's from its library. */
export async function loadDisciplineRowsFrom(port: LibraryPort): Promise<DisciplineRows> {
  const [kernel, firm] = await Promise.all([import('@permitzip/bim-kernel'), loadFirmDisciplines(port)])
  return { registered: kernel.listDisciplinesWithSource(), firm }
}

function sourceBadge(listed: ListedDiscipline) {
  const s = listed.source
  if (s.kind === 'builtin') return <Badge variant="secondary">Built in</Badge>
  if (s.kind === 'firm') return <Badge variant="outline">Firm library</Badge>
  return <Badge variant={s.firstParty ? 'secondary' : 'outline'}>{s.packName}</Badge>
}

/** Pin or unpin one firm discipline on the model `pinTo` names; disabled says why. */
function PinCell({ firm, pinTo, pinned, onPin, onUnpin }: { readonly firm: FirmDisciplineSummary; readonly pinTo: DisciplinePinTarget; readonly pinned: boolean; readonly onPin: (row: DisciplineDef) => void; readonly onUnpin: () => void }) {
  const reason = !pinTo.canEdit ? pinTo.blockedReason : !firm.row ? "This library item has no discipline row to pin yet; open it in the library above and publish it again." : null
  const button = pinned ? (
    <Button size="sm" variant="outline" disabled={!pinTo.canEdit} onClick={onUnpin} data-testid={`discipline-unpin-${firm.key}`}>
      Unpin
    </Button>
  ) : (
    <Button size="sm" variant="outline" disabled={reason !== null} onClick={() => firm.row && onPin(firm.row)} data-testid={`discipline-pin-${firm.key}`}>
      Pin to this model
    </Button>
  )
  if (reason === null || (pinned && pinTo.canEdit)) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Settings › MutinyBIM library › Disciplines: every discipline a model can
 * file work under (built in, from an add-on, or the firm's own), with its
 * parent and its suggested responsible role. The firm adds its own by
 * publishing a discipline item in the library above. Who is responsible is
 * named per model, by the project lead, in Building Model › Manage ›
 * Responsibilities.
 *
 * With `pinTo` (Building Model › Manage › Model settings › Add-ons) it lists
 * only the firm's disciplines, each with **Pin to this model**: the pin is an
 * ordinary edit (undoable; an agent's gets an Approve card) that copies the
 * row into the model, so work there can be filed under it.
 */
export function DisciplinesSectionFrom({ port, loadRows: given, pinTo }: { readonly port: LibraryPort; readonly loadRows?: () => Promise<DisciplineRows>; readonly pinTo?: DisciplinePinTarget }) {
  const fromPort = useCallback(() => loadDisciplineRowsFrom(port), [port])
  const loadRows = given ?? fromPort
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [pinError, setPinError] = useState<string | null>(null)
  const [confirmUnpin, setConfirmUnpin] = useState<FirmDisciplineSummary | null>(null)

  const fetchRows = useCallback(() => {
    loadRows()
      .then((rows) => setState({ kind: 'ready', rows }))
      .catch((err: unknown) => {
        console.error('[DisciplinesSection] the discipline list failed to load', err)
        setState({ kind: 'error', message: `The discipline list couldn't be read (${err instanceof Error ? err.message : 'unknown error'}). Models still open and keep every discipline they store.` })
      })
  }, [loadRows])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  const retry = () => {
    setState({ kind: 'loading' })
    fetchRows()
  }

  if (state.kind === 'loading') return <SettingsLoading rows={4} label="Loading disciplines" />
  if (state.kind === 'error') return <SettingsLoadError title="Disciplines didn't load" message={state.message} onRetry={retry} />

  const { registered, firm } = state.rows
  const labelOf = new Map(registered.map((l) => [l.row.id, l.row.label] as const))
  const pinnedIds = new Set(pinTo ? modelSetupOf(pinTo.model).firmDisciplines.map((d) => d.id) : [])
  // Once pinned the row is registered on the model; with a model in hand it stays in the firm list so it can be unpinned.
  const liveFirm = firm.filter((f) => !f.deprecated && (pinTo ? true : !labelOf.has(f.key)))
  const shown = pinTo ? [] : registered

  const send = (command: Parameters<DisciplinePinTarget['submit']>[0], undoLabel: string) => {
    if (!pinTo) return
    const refusal = pinTo.submit(command, undoLabel)
    if (refusal) console.error('[DisciplinesSection] the discipline pin was refused', { command: command.type, refusal })
    setPinError(refusal)
  }
  const pin = (row: DisciplineDef) => send({ type: 'pin_firm_discipline', discipline: row }, `pin ${row.label} to this model`)

  return (
    <SettingsCard
      id="disciplines"
      title={pinTo ? 'Firm disciplines' : 'Disciplines'}
      description={
        pinTo
          ? "Your firm's own disciplines (interiors, security…). Pin one to this model and work here can be filed under it; unpinning keeps what is already filed."
          : 'What work is filed under in every model: filters, view graphics, linked-model colours and, per model, who is responsible. A suggested role is only a starting point; the project lead names the responsible people in each model. A firm discipline reaches a model once it is pinned there: Building Model › Manage › Model settings › Add-ons.'
      }
    >
      {pinError && (
        <Alert variant="destructive" data-testid="discipline-pin-error">
          <AlertDescription>{pinError}</AlertDescription>
        </Alert>
      )}
      <Table>
        <TableCaption className="sr-only">{pinTo ? 'Firm disciplines and whether each is pinned to this model' : 'Disciplines, what each is part of, where it comes from and its suggested responsible role'}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Discipline</TableHead>
            <TableHead>Part of</TableHead>
            <TableHead>Comes from</TableHead>
            {pinTo ? <TableHead>On this model</TableHead> : <TableHead>Suggested responsible role</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((listed) => (
            <TableRow key={listed.row.id} data-testid={`discipline-row-${listed.row.id}`}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <span aria-hidden className="size-3 shrink-0 rounded-full border" style={{ backgroundColor: listed.row.display.colour }} />
                  <span className="font-medium">{listed.row.label}</span>
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{listed.row.parent ? (labelOf.get(listed.row.parent) ?? listed.row.parent) : listed.row.group?.label ?? '—'}</TableCell>
              <TableCell>{sourceBadge(listed)}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{listed.row.defaultResponsibleRole ?? '—'}</TableCell>
            </TableRow>
          ))}
          {liveFirm.map((f) => {
            const parent = f.row?.parent
            const pinned = pinnedIds.has(f.key)
            return (
              <TableRow key={f.key} data-testid={`discipline-row-${f.key}`}>
                <TableCell className="font-medium">{f.name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{parent ? (labelOf.get(parent) ?? parent) : '—'}</TableCell>
                <TableCell>
                  <Badge variant="outline">Firm library</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {pinTo ? (
                    <div className="flex items-center gap-2">
                      {pinned && <Badge variant="secondary">Pinned</Badge>}
                      <PinCell firm={f} pinTo={pinTo} pinned={pinned} onPin={pin} onUnpin={() => setConfirmUnpin(f)} />
                    </div>
                  ) : (
                    (f.row?.defaultResponsibleRole ?? '—')
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      {liveFirm.length === 0 && !registered.some((l) => l.source.kind === 'firm') ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Layers />
            </EmptyMedia>
            <EmptyTitle>No firm disciplines yet</EmptyTitle>
            <EmptyDescription>To add your own (interiors, security…), publish a discipline item in Settings › MutinyBIM library, for example firm:security under a built-in discipline.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <AlertDialog open={confirmUnpin !== null} onOpenChange={(open) => !open && setConfirmUnpin(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpin {confirmUnpin?.name} from this model?</AlertDialogTitle>
            <AlertDialogDescription>Work already filed under it keeps it; new work here can&apos;t be filed under it. Pin it again, or undo, to bring it back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it pinned</AlertDialogCancel>
            <AlertDialogAction
              data-testid="discipline-unpin-confirm"
              onClick={() => {
                if (confirmUnpin) send({ type: 'unpin_firm_discipline', disciplineId: confirmUnpin.key }, `unpin ${confirmUnpin.name} from this model`)
                setConfirmUnpin(null)
              }}
            >
              Unpin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
