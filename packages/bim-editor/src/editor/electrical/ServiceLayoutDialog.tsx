'use client'

import { useMemo, useState } from 'react'
import { CircleAlert, Crosshair, Network, Plus, Trash2 } from 'lucide-react'
import { elementsOfKind, type ModelState, type Vec2 } from '@permitzip/bim-kernel'
import { SERVICE_SYSTEMS, planServiceLayout, serviceLayoutRooms, type ServiceLayoutRequest, type ServiceSystem } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { SubmitCommand } from '../views-sheets/types'

export const SYSTEM_LABEL: Record<ServiceSystem, string> = { '208Y/120': '120/208 V 3-phase', '480Y/277': '277/480 V 3-phase', '120/240': '120/240 V single-phase' }
const isSystem = (v: string): v is ServiceSystem => SERVICE_SYSTEMS.some((s) => s === v)

interface Row {
  readonly key: number
  readonly kind: 'panel' | 'transformer'
  readonly name: string
  readonly fedFrom: string
  /** Bus amps for a panel, kVA for a transformer, as typed. */
  readonly size: string
  readonly system: ServiceSystem
  readonly mains: 'MLO' | 'MCB'
  readonly breaker: string
}

/** What the Service size dialog hands over: the size it found and the system it was run for. */
export interface ServiceLayoutSeed {
  readonly serviceA: number
  readonly system: ServiceSystem
}

export type ServiceLayoutWhere = 'room' | 'point' | 'origin'

/** Everything typed in the dialog, kept while the person picks a point in the plan. */
export interface ServiceLayoutDraft {
  readonly level: string
  readonly amps: string
  readonly system: ServiceSystem
  readonly meter: boolean
  readonly mainDisconnect: boolean
  /** Plan only: the gear and feeders exist (one-line, panel schedules), nothing drawn yet. */
  readonly planOnly?: boolean
  readonly mdpName: string
  readonly rows: readonly Row[]
  readonly where: ServiceLayoutWhere
  readonly roomId: string
  readonly point: Vec2 | null
}

/** The chosen place reads as chosen: filled, the others plain (outline alone looked picked). */
const PICKED = 'data-[state=off]:border-transparent data-[state=off]:bg-transparent data-[state=on]:bg-primary data-[state=on]:text-primary-foreground'

const feet = (mm: number) => `${Math.round((mm / 304.8) * 10) / 10} ft`

const positive = (s: string): number | undefined => {
  const n = Number(s)
  return s.trim() !== '' && Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Electrical › Service layout: from a service size, the meter, an optional
 * main disconnect, the main distribution and the panels and transformers you
 * list, each fed from what you pick. The preview says what each piece is and
 * what feeds it before anything is placed; Place puts it all in as one edit
 * (one undo) and opens the live one-line. bim_place_service_layout sends the
 * same command.
 */
export function ServiceLayoutDialog({
  model,
  levelId,
  seed,
  draft,
  submit,
  onClose,
  onDone,
  onPickPoint,
}: {
  readonly model: ModelState
  readonly levelId: string | null
  readonly seed: ServiceLayoutSeed | null
  /** What was typed before Pick in plan, with the point picked (when coming back from the pick). */
  readonly draft?: ServiceLayoutDraft | null
  readonly submit: SubmitCommand
  readonly onClose: () => void
  readonly onDone: () => void
  /** Close the dialog, pick a point in the plan, and reopen with this draft; absent when no plan or 3D view is open. */
  readonly onPickPoint?: (draft: ServiceLayoutDraft) => void
}) {
  const levels = elementsOfKind(model.elements, 'level')
  const rooms = useMemo(() => serviceLayoutRooms(model), [model])
  const [level, setLevel] = useState(draft?.level ?? (levelId && model.elements[levelId]?.kind === 'level' ? levelId : (levels[0]?.id ?? '')))
  const [amps, setAmps] = useState(draft?.amps ?? String(seed?.serviceA ?? 400))
  const [system, setSystem] = useState<ServiceSystem>(draft?.system ?? seed?.system ?? '208Y/120')
  const [meter, setMeter] = useState(draft?.meter ?? true)
  const [mainDisconnect, setMainDisconnect] = useState(draft?.mainDisconnect ?? false)
  const [planOnly, setPlanOnly] = useState(draft?.planOnly ?? false)
  const [mdpName, setMdpName] = useState(draft?.mdpName ?? 'MDP')
  const [rows, setRows] = useState<readonly Row[]>(draft?.rows ?? [{ key: 1, kind: 'panel', name: 'L1', fedFrom: 'MDP', size: '225', system: seed?.system ?? '208Y/120', mains: 'MCB', breaker: '' }])
  const [where, setWhere] = useState<ServiceLayoutWhere>(draft?.where ?? (rooms[0]?.electrical ? 'room' : 'origin'))
  const [roomId, setRoomId] = useState(draft?.roomId ?? rooms[0]?.id ?? '')
  const point = draft?.point ?? null
  const [submitError, setSubmitError] = useState<string | null>(null)
  const pickPoint = onPickPoint ? () => onPickPoint({ level, amps, system, meter, mainDisconnect, planOnly, mdpName, rows, where: 'point', roomId, point }) : undefined

  const update = (key: number, change: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)))
  const nextKey = rows.reduce((m, r) => Math.max(m, r.key), 0) + 1
  const sources = [mdpName.trim() || 'MDP', ...rows.map((r) => r.name.trim()).filter(Boolean)]
  const levelName = levels.find((l) => l.id === level)?.name ?? 'the level'

  const serviceA = positive(amps)
  const request = useMemo<ServiceLayoutRequest | string>(() => {
    if (!level) return 'Add a level first: the service equipment goes on one.'
    if (serviceA === undefined || !Number.isInteger(serviceA)) return 'Type the service size in whole amps (400).'
    if (!planOnly && where === 'room' && !roomId) return 'Pick the room the service goes in, or place it at a point in the plan.'
    if (!planOnly && where === 'point' && !point) return 'Press Pick in plan and click where the lineup starts.'
    const anchor = planOnly ? {} : where === 'room' ? { roomId } : where === 'point' && point ? { origin: point } : {}
    const equipment: NonNullable<ServiceLayoutRequest['equipment']>[number][] = []
    for (const r of rows) {
      const size = positive(r.size)
      const breaker = positive(r.breaker)
      if (r.kind === 'transformer') equipment.push({ kind: 'transformer', name: r.name, fedFrom: r.fedFrom, system: r.system, ...(size !== undefined ? { kva: size } : {}), ...(breaker !== undefined ? { breakerA: Math.round(breaker) } : {}) })
      else equipment.push({ kind: 'panel', name: r.name, fedFrom: r.fedFrom, system: r.system, mains: r.mains, ...(size !== undefined ? { busA: Math.round(size) } : {}), ...(breaker !== undefined ? { breakerA: Math.round(breaker) } : {}) })
    }
    return { levelId: level, ...anchor, serviceA, system, meter, mainDisconnect, ...(planOnly ? { planOnly: true } : {}), distribution: { name: mdpName }, equipment }
  }, [level, serviceA, system, meter, mainDisconnect, planOnly, mdpName, rows, where, roomId, point])
  const plan = typeof request === 'string' ? null : planServiceLayout(model, request)
  const why = typeof request === 'string' ? request : plan && !plan.ok ? plan.reason : null

  const place = (e: React.FormEvent) => {
    e.preventDefault()
    if (!plan?.ok) return
    const refusal = submit(plan.command, plan.command.label)
    if (refusal) {
      setSubmitError(refusal)
      return
    }
    onDone()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-4xl" data-testid="service-layout-dialog">
        <form onSubmit={place} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Service layout</DialogTitle>
            <DialogDescription>Start the distribution from the service size: list the panels and transformers and what feeds each. Check the preview, then place it as one edit you can undo. The one-line opens and draws it.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-3">
            <Field className="w-32">
              <FieldLabel htmlFor="bm-svc-amps">Service (A)</FieldLabel>
              <Input id="bm-svc-amps" inputMode="numeric" value={amps} onChange={(e) => setAmps(e.target.value)} data-testid="service-layout-amps" />
            </Field>
            <Field className="min-w-48 flex-1">
              <FieldLabel htmlFor="bm-svc-system">System</FieldLabel>
              <Select value={system} onValueChange={(v) => isSystem(v) && setSystem(v)}>
                <SelectTrigger id="bm-svc-system" data-testid="service-layout-system">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {SERVICE_SYSTEMS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {SYSTEM_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field className="w-36">
              <FieldLabel htmlFor="bm-svc-mdp">Main distribution</FieldLabel>
              <Input id="bm-svc-mdp" maxLength={40} value={mdpName} onChange={(e) => setMdpName(e.target.value)} data-testid="service-layout-mdp" />
            </Field>
            {levels.length > 1 && (
              <Field className="w-40">
                <FieldLabel htmlFor="bm-svc-level">Level</FieldLabel>
                <Select value={level} onValueChange={setLevel}>
                  <SelectTrigger id="bm-svc-level">
                    <SelectValue />
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
            )}
          </div>
          <div className="flex flex-wrap gap-6">
            <Field orientation="horizontal" className="w-auto">
              <Checkbox id="bm-svc-meter" checked={meter} onCheckedChange={(v) => setMeter(v === true)} />
              <FieldLabel htmlFor="bm-svc-meter">Utility meter (CT cabinet)</FieldLabel>
            </Field>
            <Field orientation="horizontal" className="w-auto">
              <Checkbox id="bm-svc-disc" checked={mainDisconnect} onCheckedChange={(v) => setMainDisconnect(v === true)} data-testid="service-layout-main-disconnect" />
              <FieldLabel htmlFor="bm-svc-disc">Separate fused main disconnect (main distribution is then main lugs only)</FieldLabel>
            </Field>
            <Field orientation="horizontal" className="w-auto">
              <Checkbox id="bm-svc-plan-only" checked={planOnly} onCheckedChange={(v) => setPlanOnly(v === true)} data-testid="service-layout-plan-only" />
              <FieldLabel htmlFor="bm-svc-plan-only">Plan only: don’t draw it yet (it waits in Not placed yet)</FieldLabel>
            </Field>
          </div>
          {!planOnly && (
          <div className="flex flex-wrap items-end gap-3">
            <Field className="w-auto">
              <FieldLabel id="bm-svc-where-label">Where it goes</FieldLabel>
              <ToggleGroup type="single" variant="outline" size="sm" aria-labelledby="bm-svc-where-label" value={where} onValueChange={(v) => (v === 'room' || v === 'point' || v === 'origin') && setWhere(v)} data-testid="service-layout-where">
                <ToggleGroupItem value="room" disabled={rooms.length === 0} className={PICKED}>
                  In a room
                </ToggleGroupItem>
                <ToggleGroupItem value="point" className={PICKED} data-testid="service-layout-where-point">
                  At a point
                </ToggleGroupItem>
                <ToggleGroupItem value="origin" className={PICKED} data-testid="service-layout-where-origin">
                  Level origin
                </ToggleGroupItem>
              </ToggleGroup>
              {rooms.length === 0 && <FieldDescription data-testid="service-layout-no-rooms">No rooms in the model yet, so In a room is off: trace them (Electrical › Propose receptacles) or pick a point.</FieldDescription>}
            </Field>
            {where === 'room' && rooms.length > 0 && (
              <Field className="min-w-48 flex-1">
                <FieldLabel htmlFor="bm-svc-room">Room</FieldLabel>
                <Select value={roomId} onValueChange={setRoomId}>
                  <SelectTrigger id="bm-svc-room" data-testid="service-layout-room">
                    <SelectValue placeholder="Pick the room" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {rooms.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            )}
            {where === 'point' && (
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={pickPoint} disabled={!pickPoint} title={pickPoint ? undefined : 'Open a plan or the 3D model to pick a point in it'} data-testid="service-layout-pick">
                  <Crosshair data-icon="inline-start" />
                  {point ? 'Pick again' : 'Pick in plan'}
                </Button>
                <FieldDescription data-testid="service-layout-point">{point ? `Starts ${feet(point.x)} east, ${feet(point.y)} north` : 'No point picked yet'}</FieldDescription>
              </div>
            )}
          </div>
          )}
          <div className="max-h-56 overflow-auto rounded-md border">
            <Table data-testid="service-layout-rows">
              <TableCaption className="sr-only">Panels and transformers to place</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>System</TableHead>
                  <TableHead>Mains</TableHead>
                  <TableHead>Fed from</TableHead>
                  <TableHead>Breaker (A)</TableHead>
                  <TableHead className="sr-only">Remove</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.key} data-testid="service-layout-row">
                    <TableCell>
                      <Input aria-label="Name" className="h-8 w-20" maxLength={40} value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} />
                    </TableCell>
                    <TableCell className="text-xs">{r.kind === 'panel' ? 'Panel' : 'Transformer'}</TableCell>
                    <TableCell>
                      <Input aria-label={r.kind === 'panel' ? `${r.name} bus amps` : `${r.name} kVA`} className="h-8 w-20" inputMode="decimal" placeholder={r.kind === 'panel' ? 'A' : 'kVA'} value={r.size} onChange={(e) => update(r.key, { size: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Select value={r.system} onValueChange={(v) => isSystem(v) && update(r.key, { system: v })}>
                        <SelectTrigger size="sm" aria-label={`${r.name} system`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {SERVICE_SYSTEMS.map((s) => (
                              <SelectItem key={s} value={s}>
                                {SYSTEM_LABEL[s]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {r.kind === 'panel' ? (
                        <Select value={r.mains} onValueChange={(v) => (v === 'MLO' || v === 'MCB') && update(r.key, { mains: v })}>
                          <SelectTrigger size="sm" aria-label={`${r.name} mains`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="MCB">Main breaker</SelectItem>
                              <SelectItem value="MLO">Main lugs</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Select value={r.fedFrom} onValueChange={(v) => update(r.key, { fedFrom: v })}>
                        <SelectTrigger size="sm" aria-label={`${r.name} fed from`} data-testid={`service-layout-fed-from-${r.key}`}>
                          <SelectValue placeholder="Fed from" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {[...new Set(sources)]
                              .filter((s) => s !== r.name.trim())
                              .map((s) => (
                                <SelectItem key={s} value={s}>
                                  {s}
                                </SelectItem>
                              ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Input aria-label={`${r.name} feeder breaker`} className="h-8 w-20" inputMode="numeric" placeholder={r.kind === 'transformer' ? 'Required' : 'Default'} value={r.breaker} onChange={(e) => update(r.key, { breaker: e.target.value })} />
                    </TableCell>
                    <TableCell>
                      <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${r.name}`} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { key: nextKey, kind: 'panel', name: `L${nextKey}`, fedFrom: mdpName.trim() || 'MDP', size: '225', system, mains: 'MCB', breaker: '' }])} data-testid="service-layout-add-panel">
              <Plus data-icon="inline-start" />
              Add panel
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, { key: nextKey, kind: 'transformer', name: `T${nextKey}`, fedFrom: mdpName.trim() || 'MDP', size: '', system: '208Y/120', mains: 'MLO', breaker: '' }])} data-testid="service-layout-add-transformer">
              <Plus data-icon="inline-start" />
              Add transformer
            </Button>
          </div>
          {why ? (
            <Alert variant="destructive" data-testid="service-layout-refusal">
              <CircleAlert />
              <AlertTitle>Not ready to place</AlertTitle>
              <AlertDescription>{why}</AlertDescription>
            </Alert>
          ) : (
            plan?.ok && (
              <div className="flex flex-col gap-1 text-sm" data-testid="service-layout-preview">
                <p className="font-medium">
                  {planOnly ? `Plans ${plan.items.length} pieces for ${levelName}, ${plan.where}:` : `Places ${plan.items.length} pieces on ${levelName}, ${plan.where}:`}
                </p>
                <ol className="list-decimal pl-5">
                  {plan.items.map((i) => (
                    <li key={i.partId}>
                      <span className="font-medium">{i.name}</span>: {i.what}
                      {i.fedFrom && `, fed from ${i.fedFrom}${i.breakerA ? ` through a ${i.breakerA} A breaker` : ''}`}
                    </li>
                  ))}
                </ol>
                {plan.notes.map((n) => (
                  <FieldDescription key={n} className="text-warning-700">
                    {n}
                  </FieldDescription>
                ))}
              </div>
            )
          )}
          {submitError && (
            <FieldDescription className="text-danger-600" role="alert">
              {submitError}
            </FieldDescription>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!plan?.ok} data-testid="service-layout-place">
              <Network data-icon="inline-start" />
              {planOnly ? 'Plan and open the one-line' : 'Place and open the one-line'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
