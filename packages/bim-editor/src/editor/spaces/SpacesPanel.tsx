'use client'

import { useMemo, useState } from 'react'
import { BrickWall, ChevronDown, Combine, Flame, Layers, Lock, LockOpen, PencilRuler, Plus, Rows3, ScanSearch, SquareSplitHorizontal, SquareDashed, Trash2, X, Zap } from 'lucide-react'
import { childrenOf, elementsOfKind, isCalibrated, zonePurposeWords, type Command, type ElementId, type ModelState, type ZonePurpose } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../../ui/alert-dialog'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../../ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '../../ui/empty'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../../ui/select'
import { Skeleton } from '../../ui/skeleton'
import { Slider } from '../../ui/slider'
import { Switch } from '../../ui/switch'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { newElementId } from '../placement'
import { MakeCeilingFromHeightButton } from '../ceilings/MakeCeilingFromHeightButton'
import { SpaceLoadsDialog } from './SpaceLoadsDialog'
import { SpaceLinkedEnvelope } from './SpaceLinkedEnvelope'
import { LinkedCopiesReview } from './LinkedCopiesReview'
import { CodeZonesList } from './CodeZonesList'
import { OpenRoomsAlert } from './OpenRoomsAlert'
import { ProposedRoomsReview } from './ProposedRoomsReview'
import { FireAreasReview } from './FireAreasReview'
import type { FireAreaControls } from './use-fire-areas'
import { SpaceBoundaryProperties } from './SpaceBoundaryProperties'
import type { ProposeControls } from './use-spaces-tool'
import { useWindowedRows, windowBoxStyle, windowSlice } from '../use-windowed-rows'
import { figuresLine, formatLoadAmount, LOAD_QUANTITIES, scopeFigures, type LoadScope } from './space-loads'
import { formatFt2, nextSpaceNumber, setUseCommand, SPACE_USES, spaceRows, spaceUsesIn, zoneFitHeading, zoneRows, zoneServers, type SpaceLoadsReader, type SpaceRow } from './space-rows'

const NO_USE = '__none__'
const NOBODY = '__nobody__'
const PURPOSES: ReadonlyArray<{ readonly value: ZonePurpose; readonly label: string }> = [
  { value: 'thermal', label: 'Thermal (HVAC)' },
  { value: 'ventilation', label: 'Ventilation' },
  { value: 'electrical_load_region', label: 'Electrical load area' },
  { value: 'lighting_control', label: 'Lighting control' },
  { value: 'fire_area', label: 'Fire area' },
  { value: 'drainage_catchment', label: 'Drainage area' },
]
/** Purposes a zone can have but the "Make zone" picker doesn't offer (code zones come from equipment). */
const OTHER_PURPOSE_LABELS: Readonly<Partial<Record<ZonePurpose, string>>> = { code_clearance: 'Code clearance' }

interface Props {
  /** Null while the model is loading. */
  readonly model: ModelState | null
  readonly error?: string | null
  readonly onRetry?: () => void
  /** The plan the person is on; spaces drawn and drawings added go on its level. */
  readonly levelId: ElementId | null
  readonly levelName: string | null
  readonly canEdit: boolean
  readonly blockedReason: string
  readonly submit: (command: Command, undoLabel: string) => string | null
  /** The Draw space tool is on (its button shows Stop). */
  readonly drawing: boolean
  readonly onDrawSpace: () => void
  readonly onRedrawSpace: (spaceId: ElementId) => void
  readonly onStopDrawing: () => void
  readonly onAddUnderlay: () => void
  readonly onCalibrate: (underlayId: ElementId) => void
  readonly onSelectSpace?: (spaceId: ElementId) => void
  /** Room from walls on the plan (use-spaces-tool). Absent: not offered. */
  readonly onRoomFromWalls?: () => void
  /** Separation line on the plan, then Split space. Absent: not offered. */
  readonly onSeparationLine?: () => void
  /** Select model elements (a room's wall, a room that opened); absent: rows only select spaces. */
  readonly onSelectElements?: (ids: readonly ElementId[]) => void
  /** Undo the last edit (offered on a room that opened). */
  readonly onUndo?: () => void
  /** Allocated vs actual per space from the loads layer, when it is mounted. */
  readonly loads?: SpaceLoadsReader
  /** "Propose rooms from this drawing" (use-spaces-tool). Absent: the action isn't offered. */
  readonly propose?: ProposeControls
  /** "Fire areas from rated walls" (use-spaces-tool). Absent: the action isn't offered. */
  readonly fireAreas?: FireAreaControls
  readonly onClose: () => void
  /** The project the model belongs to (add-ons' sections of a space's Loads read its tables). */
  readonly projectId?: string | null
}

/** The loads layer's figures for a row, when the engine has none of its own to say (estimate vs devices, never "allocated"). */
function loadText(row: SpaceRow): string | null {
  if (!row.loads) return null
  const parts = LOAD_QUANTITIES.flatMap((q) => {
    const a = row.loads?.allocated[q.key] ?? 0
    const b = row.loads?.actual[q.key] ?? 0
    return a === 0 && b === 0 ? [] : [`${q.label}: estimate ${formatLoadAmount(q.key, a)}, devices so far ${formatLoadAmount(q.key, b)}`]
  })
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * Building Model › Spaces (F3): the engineers' own spaces, drawn over the
 * architect's PDF or made from rooms, with use, area (from the outline) and
 * occupants; zones made from selected spaces and assigned to equipment; the
 * drawings placed under the current level with their scale state.
 */
/** Estimated height of one spaces table row (inputs and a select), px. */
const SPACE_ROW_PX = 45

export function SpacesPanel(props: Props) {
  const { model, error, onRetry, levelId, levelName, canEdit, blockedReason, submit, drawing, onDrawSpace, onRedrawSpace, onStopDrawing, onAddUnderlay, onCalibrate, onSelectSpace, onRoomFromWalls, onSeparationLine, onSelectElements, onUndo, loads, propose, fireAreas, onClose } = props
  const [detailFor, setDetailFor] = useState<ElementId | null>(null)
  const rows = useMemo(() => (model ? spaceRows(model, loads) : []), [model, loads])
  const windowRows = useWindowedRows(rows.length, SPACE_ROW_PX)
  const zones = useMemo(() => (model ? zoneRows(model) : []), [model])
  const modelId = model?.modelId
  const settings = model?.settings
  const uses = useMemo(() => (modelId && settings ? spaceUsesIn({ modelId, settings }) : SPACE_USES), [modelId, settings])
  const serversByPurpose = useMemo(() => {
    const out = new Map<ZonePurpose, ReturnType<typeof zoneServers>>()
    if (model) for (const { zone } of zones) if (!out.has(zone.purpose)) out.set(zone.purpose, zoneServers(model, zone.purpose))
    return out
  }, [model, zones])
  const figuresByScope = useMemo(() => {
    const out = new Map<ElementId, string>()
    if (!model) return out
    for (const r of rows) {
      const f = scopeFigures(model, { kind: 'space', id: r.id })
      if (f) out.set(r.id, figuresLine(f))
    }
    for (const { zone } of zones) {
      const f = scopeFigures(model, { kind: 'zone', id: zone.id })
      if (f) out.set(zone.id, figuresLine(f))
    }
    return out
  }, [model, rows, zones])
  const [loadsFor, setLoadsFor] = useState<LoadScope | null>(null)
  const underlays = useMemo(() => (model && levelId ? elementsOfKind(model.elements, 'drawing_underlay').filter((u) => u.levelId === levelId) : []), [model, levelId])
  const roomCount = useMemo(() => (model ? elementsOfKind(model.elements, 'room').length : 0), [model])
  const [selected, setSelected] = useState<ReadonlySet<ElementId>>(new Set())
  const [zoneName, setZoneName] = useState('')
  const [zonePurpose, setZonePurpose] = useState<ZonePurpose>('thermal')
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; body: string; command: Command; label: string; action?: string } | null>(null)

  const send = (command: Command, label: string): boolean => {
    const refused = submit(command, label)
    setNotice(refused ? { tone: 'error', text: refused } : null)
    return refused === null
  }

  const editReason = canEdit ? null : blockedReason
  const drawReason = editReason ?? (levelId ? null : 'Open a floor plan to draw spaces on its level.')
  const fromRoomsReason = editReason ?? (roomCount === 0 ? 'This model has no rooms. Trace spaces over a drawing instead.' : null)

  const addRow = () => {
    if (!model) return
    const number = nextSpaceNumber(model, levelId)
    send({ type: 'create_space', spaces: [{ spaceId: newElementId('space'), number, name: `Space ${number}`, ...(levelId ? { levelId } : {}) }] }, 'Add space')
  }
  const makeFromRooms = () => {
    if (send({ type: 'make_spaces_from_rooms', ...(levelId ? { levelId } : {}) }, 'Make spaces from rooms')) setNotice({ tone: 'info', text: `Made spaces from the rooms${levelName ? ` on ${levelName}` : ''}.` })
  }
  const makeZone = () => {
    const name = zoneName.trim() || `Zone ${zones.length + 1}`
    if (send({ type: 'create_zone', zoneId: newElementId('zone'), name, purpose: zonePurpose, spaceIds: [...selected] }, 'Make zone')) {
      setSelected(new Set())
      setZoneName('')
    }
  }

  const header = (
    <header className="flex items-center gap-2">
      <h2 className="text-sm font-semibold">Spaces{model && !error ? `: ${rows.length}` : ''}</h2>
      <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Close Spaces" onClick={onClose}>
        <X />
      </Button>
    </header>
  )

  if (error)
    return (
      <section className="flex min-h-0 flex-col gap-3" aria-label="Spaces" data-testid="spaces-panel">
        {header}
        <Alert variant="destructive" data-testid="spaces-error">
          <AlertTitle>The spaces didn’t load</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error}</span>
            {onRetry ? (
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      </section>
    )
  if (!model)
    return (
      <section className="flex min-h-0 flex-col gap-3" aria-label="Spaces" data-testid="spaces-panel" aria-busy="true">
        {header}
        <span className="sr-only">Loading the spaces</span>
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </section>
    )

  return (
    <section className="flex min-h-0 flex-col gap-3" aria-label="Spaces" data-testid="spaces-panel">
      {header}
      <div className="flex flex-wrap gap-2">
        {drawing ? (
          <Button size="sm" variant="secondary" onClick={onStopDrawing} data-testid="spaces-stop-drawing">
            Stop drawing (Esc)
          </Button>
        ) : (
          <Button size="sm" onClick={onDrawSpace} disabled={drawReason !== null} title={drawReason ?? 'Click the corners of a space on the plan'} data-testid="spaces-draw">
            <PencilRuler data-icon="inline-start" />
            Draw space
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onAddUnderlay} disabled={drawReason !== null} title={drawReason ?? 'Put an architect’s PDF or picture under this plan to trace over'} data-testid="spaces-add-underlay">
          <Layers data-icon="inline-start" />
          Add drawing
        </Button>
        <Button size="sm" variant="outline" onClick={makeFromRooms} disabled={fromRoomsReason !== null} title={fromRoomsReason ?? 'One space per room, following the room'} data-testid="spaces-from-rooms">
          <SquareDashed data-icon="inline-start" />
          Make from rooms
        </Button>
        {onRoomFromWalls || onSeparationLine || propose || fireAreas ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={editReason !== null || drawing} title={editReason ?? (drawing ? 'Stop drawing first.' : 'Make, find and split rooms, and find fire areas, from the walls on this plan')} data-testid="spaces-walls-menu">
                <BrickWall data-icon="inline-start" />
                Rooms from walls
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                {onRoomFromWalls ? (
                  <DropdownMenuItem disabled={drawReason !== null} title={drawReason ?? undefined} onSelect={onRoomFromWalls} data-testid="spaces-room-from-walls">
                    <BrickWall />
                    Room from walls
                    <span className="ml-auto text-xs text-muted-foreground">Hover, then click inside</span>
                  </DropdownMenuItem>
                ) : null}
                {propose ? (
                  <DropdownMenuItem disabled={propose.wallsReason !== null || propose.state.kind === 'review'} title={propose.wallsReason ?? (propose.state.kind === 'review' ? 'Finish the review open below first.' : undefined)} onSelect={propose.startFromWalls} data-testid="spaces-find-from-walls">
                    <ScanSearch />
                    Find rooms from walls
                    <span className="ml-auto text-xs text-muted-foreground">Review each</span>
                  </DropdownMenuItem>
                ) : null}
                {propose?.linkedWalls.shown ? (
                  <DropdownMenuCheckboxItem
                    checked={propose.linkedWalls.on}
                    onCheckedChange={propose.linkedWalls.toggle}
                    onSelect={(e) => e.preventDefault()}
                    title={propose.linkedWalls.note ?? "Find rooms from walls also uses the linked model's walls as room boundaries"}
                    data-testid="spaces-use-linked-walls"
                  >
                    Use the linked model&apos;s walls
                    {propose.linkedWalls.note ? <span className="ml-auto text-xs text-muted-foreground">{propose.linkedWalls.note.startsWith('Still') ? 'Loading…' : 'Not available'}</span> : null}
                  </DropdownMenuCheckboxItem>
                ) : null}
                {fireAreas ? (
                  <DropdownMenuItem
                    disabled={fireAreas.reason !== null || fireAreas.state.kind !== 'idle'}
                    title={fireAreas.reason ?? (fireAreas.state.kind !== 'idle' ? 'Finish the fire-area review open below first.' : 'Find the areas closed by rated walls on this level; you accept each as a fire-area zone')}
                    onSelect={fireAreas.start}
                    data-testid="spaces-fire-areas"
                  >
                    <Flame />
                    Fire areas from rated walls
                    <span className="ml-auto text-xs text-muted-foreground">Accept each</span>
                  </DropdownMenuItem>
                ) : null}
                {onSeparationLine ? (
                  <DropdownMenuItem disabled={drawReason !== null} title={drawReason ?? undefined} onSelect={onSeparationLine} data-testid="spaces-split">
                    <SquareSplitHorizontal />
                    Split space
                    <span className="ml-auto text-xs text-muted-foreground">Line wall to wall</span>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {propose ? (
          <Button
            size="sm"
            variant="outline"
            onClick={propose.start}
            disabled={(editReason ?? propose.reason) !== null || propose.state.kind === 'loading' || propose.state.kind === 'review'}
            title={editReason ?? propose.reason ?? 'Find the closed rooms on the drawing under this plan; you accept or reject each before anything is saved'}
            data-testid="spaces-propose-rooms"
          >
            <ScanSearch data-icon="inline-start" />
            Propose rooms from this drawing
          </Button>
        ) : null}
      </div>
      {propose ? <ProposedRoomsReview propose={propose} editReason={editReason} /> : null}
      {fireAreas ? <FireAreasReview fire={fireAreas} editReason={editReason} levelName={levelName} /> : null}
      {editReason ? <p className="text-xs text-muted-foreground">{editReason}</p> : null}

      <OpenRoomsAlert model={model} onSelect={onSelectElements} onUndo={onUndo} />

      {notice ? (
        <Alert variant={notice.tone === 'error' ? 'destructive' : 'default'} data-testid="spaces-notice">
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : null}

      {underlays.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="spaces-underlays">
          <h3 className="text-xs font-medium text-muted-foreground">Drawings under {levelName ?? 'this plan'}</h3>
          <p className="text-xs text-muted-foreground" data-testid="spaces-underlay-where">Drawings show on this level’s printed drawing (view Show › Printed drawing) and while you draw spaces. The live model doesn’t show them.</p>
          {underlays.map((u) => {
            const calibrated = isCalibrated(u)
            return (
              <div key={u.id} className="flex flex-col gap-2 rounded border p-2" data-testid="spaces-underlay" data-underlay={u.id} data-calibrated={calibrated}>
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm">{u.source.name}{u.source.page ? `, page ${u.source.page}` : ''}</span>
                  {calibrated ? <Badge variant="secondary">Scale set</Badge> : <Badge variant="destructive">Not calibrated: tracing is off</Badge>}
                  <Button size="sm" variant={calibrated ? 'ghost' : 'default'} className="ml-auto" onClick={() => onCalibrate(u.id)} disabled={editReason !== null || u.locked === true} title={u.locked ? 'Unlock it to change its scale.' : editReason ?? undefined} data-testid="spaces-calibrate">
                    {calibrated ? 'Rescale' : 'Set scale'}
                  </Button>
                </div>
                {!calibrated ? <p className="text-xs text-muted-foreground">Pick two points a known distance apart, or type the printed scale. Until then spaces drawn here aren’t traced over it.</p> : null}
                <div className="flex items-center gap-3 text-xs">
                  <span className="w-14">Opacity</span>
                  <Slider className="w-32" min={10} max={100} step={5} value={[u.opacityPct ?? 50]} disabled={editReason !== null} onValueCommit={(v) => send({ type: 'edit_underlay', underlayId: u.id, opacityPct: v[0] ?? 50 }, 'Underlay opacity')} aria-label={`Opacity of ${u.source.name}`} />
                  <label className="flex items-center gap-1">
                    {u.locked ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                    <Switch checked={u.locked === true} disabled={editReason !== null} onCheckedChange={(v) => send({ type: 'edit_underlay', underlayId: u.id, locked: v }, v ? 'Lock underlay' : 'Unlock underlay')} aria-label="Lock so it can't slide" />
                    Lock
                  </label>
                  <label className="flex items-center gap-1">
                    <Switch checked={u.hidden !== true} disabled={editReason !== null} onCheckedChange={(v) => send({ type: 'edit_underlay', underlayId: u.id, hidden: !v }, v ? 'Show underlay' : 'Hide underlay')} aria-label="Show on the printed drawing" />
                    Show on printed drawing
                  </label>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${u.source.name}`} disabled={editReason !== null} onClick={() => setConfirm({ title: `Remove ${u.source.name}?`, body: 'The drawing comes off this plan. Spaces traced over it keep their outlines. Undo puts it back.', command: { type: 'delete_underlays', underlayIds: [u.id] }, label: 'Remove underlay' })}>
                    <Trash2 />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <Empty className="border" data-testid="spaces-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Rows3 />
            </EmptyMedia>
            <EmptyTitle>No spaces yet</EmptyTitle>
            <EmptyDescription>
              Two ways to start. Most jobs only have the architect’s PDF: add it with <strong>Add drawing</strong>, set its scale, then <strong>Draw space</strong> over each room. If the model has rooms, <strong>Make from rooms</strong> makes one space per room.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button size="sm" onClick={onAddUnderlay} disabled={drawReason !== null} title={drawReason ?? undefined}>
              Trace over a drawing
            </Button>
            <Button size="sm" variant="outline" onClick={makeFromRooms} disabled={fromRoomsReason !== null} title={fromRoomsReason ?? undefined}>
              Make from rooms
            </Button>
            <Button size="sm" variant="ghost" onClick={addRow} disabled={editReason !== null} title={editReason ?? 'Type a space into the list now; draw it later'} data-testid="spaces-add-row">
              <Plus data-icon="inline-start" />
              Add row
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
        <div className="flex justify-end">
          <Button size="sm" variant="ghost" onClick={addRow} disabled={editReason !== null} title={editReason ?? 'Type a space into the list now; draw it later'} data-testid="spaces-add-row">
            <Plus data-icon="inline-start" />
            Add row
          </Button>
        </div>
        <div ref={windowRows.scrollRef} className="min-h-0 overflow-auto" style={windowBoxStyle(windowRows)}>
          <Table data-testid="spaces-table">
            <TableCaption className="sr-only">Spaces with their use, area, occupants and loads</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6">
                  <span className="sr-only">Pick for a zone</span>
                </TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Use</TableHead>
                <TableHead className="text-right">Area</TableHead>
                <TableHead className="text-right">Occupants</TableHead>
                <TableHead>Loads</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {windowRows.padTop > 0 && <TableRow aria-hidden="true" className="border-0 hover:bg-transparent" style={{ height: windowRows.padTop }} />}
              {windowSlice(rows, windowRows).map(({ item: r, index }) => (
                <TableRow key={r.id} ref={windowRows.measure} data-index={index} data-testid="spaces-row" data-space={r.id} data-state={detailFor === r.id ? 'selected' : undefined} onClick={() => { setDetailFor(r.id); onSelectSpace?.(r.id) }}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(r.id)}
                      onCheckedChange={(v) => setSelected((s) => { const n = new Set(s); if (v === true) n.add(r.id); else n.delete(r.id); return n })}
                      aria-label={`Pick ${r.label} for a zone`}
                    />
                  </TableCell>
                  <TableCell>
                    <Input className="h-7 w-16" defaultValue={r.number} disabled={editReason !== null} aria-label="Space number" onBlur={(e) => e.target.value.trim() !== r.number && send({ type: 'edit_space', spaceId: r.id, number: e.target.value.trim() }, 'Renumber space')} />
                  </TableCell>
                  <TableCell>
                    <Input className="h-7 w-32" defaultValue={r.name} disabled={editReason !== null} aria-label="Space name" data-testid="spaces-name" onBlur={(e) => e.target.value.trim() !== r.name && send({ type: 'edit_space', spaceId: r.id, name: e.target.value.trim() }, 'Rename space')} />
                  </TableCell>
                  <TableCell className="text-xs">{r.levelName ?? 'Not on a level'}</TableCell>
                  <TableCell>
                    <Select
                      value={r.useId ?? NO_USE}
                      disabled={editReason !== null}
                      onValueChange={(v) => {
                        const c = setUseCommand(r.id, v === NO_USE ? null : v, uses, model ?? undefined)
                        if (typeof c === 'string') setNotice({ tone: 'error', text: c })
                        else send(c, 'Set space use')
                      }}
                    >
                      <SelectTrigger className="h-7 w-44" aria-label={`Use of ${r.label}`} data-testid="spaces-use">
                        <SelectValue placeholder="Pick a use" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value={NO_USE}>No use yet</SelectItem>
                        </SelectGroup>
                        {[...new Set(uses.map((u) => u.category))].map((cat) => (
                          <SelectGroup key={cat}>
                            <SelectLabel>{cat}</SelectLabel>
                            {uses.filter((u) => u.category === cat).map((u) => (
                              <SelectItem key={u.id} value={u.id}>
                                {u.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right tabular-nums" data-testid="spaces-area">
                    {formatFt2(r.areaFt2)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Input
                      className="h-7 w-16 text-right tabular-nums"
                      key={`${r.id}:${r.occupants ?? ''}`}
                      defaultValue={r.occupants ?? ''}
                      placeholder={r.useName ? '' : 'Pick a use'}
                      disabled={editReason !== null}
                      aria-label={`Occupants of ${r.label}${r.occupantsTyped ? ' (typed)' : ' (from the use)'}`}
                      title={r.occupantsTyped ? 'Typed. Clear it to go back to the use’s default.' : 'From the use’s default density. Type a number to override.'}
                      data-testid="spaces-occupants"
                      onBlur={(e) => {
                        const t = e.target.value.trim()
                        if (t === '' && r.occupantsTyped) send({ type: 'edit_space', spaceId: r.id, occupants: null }, 'Occupants from the use')
                        else if (t !== '' && Number(t) !== r.occupants) {
                          const n = Number(t)
                          if (!Number.isInteger(n) || n < 0) setNotice({ tone: 'error', text: 'Occupants is a whole number of people.' })
                          else send({ type: 'edit_space', spaceId: r.id, occupants: n }, 'Set occupants')
                        }
                      }}
                    />
                  </TableCell>
                  <TableCell className="max-w-56 text-xs">
                    {(() => {
                      const line = figuresByScope.get(r.id) ?? loadText(r)
                      return (
                        <div className="flex flex-col items-start gap-0.5">
                          <Button
                            variant={line ? 'link' : 'outline'}
                            size="sm"
                            className={line ? 'h-auto whitespace-normal p-0 text-left text-xs' : 'h-7'}
                            aria-label={line ? `Loads on ${r.label}: ${line}` : `Add load to ${r.label}`}
                            title={line ? 'See, change or add loads' : 'Lighting, receptacles or any load, as a total or per square foot'}
                            data-testid="spaces-loads"
                            onClick={(e) => {
                              e.stopPropagation()
                              setLoadsFor({ kind: 'space', id: r.id, label: r.label })
                            }}
                          >
                            {line ? null : <Plus data-icon="inline-start" />}
                            {line ?? 'Add load'}
                          </Button>
                          <span className="text-muted-foreground">{r.zones.length > 0 ? r.zones.join(', ') : r.madeBy}</span>
                        </div>
                      )
                    })()}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Button variant="ghost" size="icon-sm" aria-label={`${r.areaFt2 === null ? 'Draw' : 'Redraw'} ${r.label}`} title={drawReason ?? (r.areaFt2 === null ? 'Draw it on the plan' : 'Redraw its outline')} disabled={drawReason !== null} onClick={() => onRedrawSpace(r.id)}>
                      <PencilRuler />
                    </Button>
                    <MakeCeilingFromHeightButton model={model} spaceId={r.id} label={r.label} editReason={editReason} submit={submit} />
                    {childrenOf(model.elements, r.id).length > 0 ? (
                      <Button variant="ghost" size="icon-sm" aria-label={`Merge ${r.label} back into one room`} title={editReason ?? 'Remove the separation line and merge the sub-rooms back, with their loads'} disabled={editReason !== null} data-testid="spaces-merge-back" onClick={(e) => { e.stopPropagation(); setConfirm({ title: `Merge ${r.label} back into one room?`, body: 'The separation line and the sub-rooms go; their loads come back to the room. Undo splits it again.', command: { type: 'merge_space_children', spaceId: r.id }, label: 'Merge back', action: 'Merge back' }) }}>
                        <Combine />
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="icon-sm" aria-label={`Delete ${r.label}`} disabled={editReason !== null} onClick={() => setConfirm({ title: `Delete ${r.label}?`, body: 'It comes out of every zone. Undo puts it back.', command: { type: 'delete_spaces', spaceIds: [r.id] }, label: 'Delete space' })}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {windowRows.padBottom > 0 && <TableRow aria-hidden="true" className="border-0 hover:bg-transparent" style={{ height: windowRows.padBottom }} />}
            </TableBody>
          </Table>
        </div>
        </>
      )}

      {detailFor && model.elements[detailFor]?.kind === 'space' ? (
        <div className="flex flex-col gap-2 border-t pt-2" data-testid="spaces-detail">
          <h3 className="text-xs font-medium text-muted-foreground">{rows.find((r) => r.id === detailFor)?.label ?? 'Space'}</h3>
          <SpaceBoundaryProperties model={model} spaceId={detailFor} onSelectElement={onSelectElements ? (id) => onSelectElements([id]) : undefined} />
          <SpaceLinkedEnvelope model={model} spaceId={detailFor} submit={submit} editReason={editReason} />
        </div>
      ) : null}

      <LinkedCopiesReview model={model} submit={submit} editReason={editReason} />

      {rows.length > 0 || zones.length > 0 ? (
        <div className="flex flex-col gap-2 border-t pt-2" data-testid="spaces-zones">
          <h3 className="text-xs font-medium text-muted-foreground">Zones</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-8 w-36" placeholder={`Zone ${zones.length + 1}`} value={zoneName} onChange={(e) => setZoneName(e.target.value)} aria-label="New zone name" data-testid="spaces-zone-name" />
            <Select value={zonePurpose} onValueChange={(v) => setZonePurpose(PURPOSES.find((p) => p.value === v)?.value ?? 'thermal')}>
              <SelectTrigger className="h-8 w-44" aria-label="Zone purpose">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PURPOSES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={makeZone} disabled={editReason !== null || selected.size === 0} title={editReason ?? (selected.size === 0 ? 'Tick the spaces that make the zone first.' : undefined)} data-testid="spaces-make-zone">
              Make zone from {selected.size} selected
            </Button>
          </div>
          {zones.length === 0 ? (
            <p className="text-xs text-muted-foreground">No zones yet. Tick spaces above, name the zone, and make it. Then pick the equipment that serves it.</p>
          ) : (
            zones.map(({ zone, servedByMark, spaceLabels, boundsLine }) => {
              const servers = serversByPurpose.get(zone.purpose) ?? { fits: [], others: [] }
              const zoneLine = figuresByScope.get(zone.id)
              return (
              <div key={zone.id} className="flex flex-wrap items-center gap-2 text-sm" data-testid="spaces-zone" data-zone={zone.id}>
                <span className="font-medium">{zone.name}</span>
                <Badge variant="outline">{PURPOSES.find((p) => p.value === zone.purpose)?.label ?? OTHER_PURPOSE_LABELS[zone.purpose] ?? zonePurposeWords(zone.purpose)}</Badge>
                <span className="text-xs text-muted-foreground" data-testid="spaces-zone-covers">{boundsLine ?? (spaceLabels.length === 0 ? 'no spaces' : spaceLabels.join(', '))}</span>
                <Select
                  value={zone.servedBy ?? NOBODY}
                  disabled={editReason !== null}
                  onValueChange={(v) => send({ type: 'edit_zone', zoneId: zone.id, servedBy: v === NOBODY ? null : v }, 'Assign zone to equipment')}
                >
                  <SelectTrigger className="ml-auto h-7 w-44" aria-label={`Equipment serving ${zone.name}`} data-testid="spaces-zone-served-by">
                    <SelectValue placeholder="Served by…">{servedByMark ? `Served by ${servedByMark}` : 'Not assigned'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NOBODY}>Not assigned</SelectItem>
                    </SelectGroup>
                    {servers.fits.length === 0 && servers.others.length === 0 ? (
                      <SelectGroup>
                        <SelectItem value="__none_available__" disabled>
                          No equipment with a mark yet
                        </SelectItem>
                      </SelectGroup>
                    ) : (
                      <>
                        <SelectGroup data-testid="spaces-zone-fits">
                          <SelectLabel>{zoneFitHeading(zone.purpose)}</SelectLabel>
                          {servers.fits.length === 0 ? (
                            <SelectItem value="__no_fit__" disabled>
                              None yet: equipment with an airflow, a duct connection or an HVAC load lists here
                            </SelectItem>
                          ) : (
                            servers.fits.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.label}
                              </SelectItem>
                            ))
                          )}
                        </SelectGroup>
                        {servers.others.length > 0 ? (
                          <SelectGroup data-testid="spaces-zone-others">
                            <SelectLabel>Other equipment</SelectLabel>
                            {servers.others.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ) : null}
                      </>
                    )}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  aria-label={zoneLine ? `Loads on ${zone.name}: ${zoneLine}` : `Add load to ${zone.name}`}
                  title={zoneLine ?? 'Loads spread over the whole zone'}
                  data-testid="spaces-zone-loads"
                  onClick={() => setLoadsFor({ kind: 'zone', id: zone.id, label: zone.name })}
                >
                  <Zap data-icon="inline-start" />
                  Loads
                </Button>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${zone.name}`} disabled={editReason !== null} onClick={() => setConfirm({ title: `Delete ${zone.name}?`, body: 'Its spaces stay. Undo puts the zone back.', command: { type: 'delete_zones', zoneIds: [zone.id] }, label: 'Delete zone' })}>
                  <Trash2 />
                </Button>
                {zoneLine ? <p className="basis-full text-xs text-muted-foreground" data-testid="spaces-zone-figures">{zoneLine}</p> : null}
              </div>
              )
            })
          )}
        </div>
      ) : null}

      <CodeZonesList model={model} levelId={levelId} editReason={editReason} send={send} />

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirm) send(confirm.command, confirm.label)
                setConfirm(null)
              }}
            >
              {confirm?.action ?? 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <SpaceLoadsDialog scope={loadsFor} model={model} canEdit={canEdit} blockedReason={blockedReason} submit={submit} onClose={() => setLoadsFor(null)} projectId={props.projectId ?? null} />
    </section>
  )
}
