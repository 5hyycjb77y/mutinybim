'use client'

import { useMemo, useState } from 'react'
import { Check, CircleAlert, MousePointerClick, Plus, Save, ToggleLeft, Trash2, X } from 'lucide-react'
import { elementsOfKind, roomOf, roomText, type ModelState, type PartInstance, type PartTypeElement } from '@permitzip/bim-kernel'
import { Alert, AlertDescription } from '../../ui/alert'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import type { SubmitCommand } from '../views-sheets/types'

const CONTROL_TYPES = ['line_voltage', '0-10v', 'dali', 'low_voltage', 'wireless'] as const
type ControlType = (typeof CONTROL_TYPES)[number]

const CONTROL_PROTOCOL_LABELS: Readonly<Record<ControlType, string>> = {
  line_voltage: 'Line voltage',
  '0-10v': '0-10V',
  dali: 'DALI',
  low_voltage: 'Low voltage',
  wireless: 'Wireless',
}

type EmergencyMode = 'none' | 'unswitched' | 'switched'

const EMERGENCY_MODES: ReadonlyArray<{ readonly value: EmergencyMode; readonly label: string; readonly hint: string }> = [
  { value: 'none', label: 'Normal', hint: 'Standard fixture powered by its branch circuit.' },
  { value: 'unswitched', label: 'Emergency (unswitched)', hint: 'Constant-hot battery / EM circuit; shaded half-fill on plans.' },
  { value: 'switched', label: 'Switched EM (UL 924)', hint: 'Switches with the room under normal power and overrides ON on power loss.' },
]

function isControlCapablePart(model: ModelState, el: PartInstance): boolean {
  const type = model.elements[el.typeId]
  if (type?.kind !== 'part_type') return false
  const cat = type.definition.category
  return cat === 'lighting_fixture' || cat === 'electrical_device'
}

function isControllerPart(model: ModelState, el: PartInstance): boolean {
  const type = model.elements[el.typeId]
  if (type?.kind !== 'part_type') return false
  return type.definition.category === 'electrical_device' && /(switch|dimmer|sensor|photocell|time clock|relay pack)/i.test(type.definition.familyName)
}

function isLightingPart(model: ModelState, el: PartInstance): boolean {
  const type = model.elements[el.typeId]
  return type?.kind === 'part_type' && type.definition.category === 'lighting_fixture'
}

function partMark(part: PartInstance): string {
  const m = part.mark?.trim()
  if (m) return m
  const v = part.values.mark ?? part.values.type_mark
  return typeof v === 'string' && v.trim() ? v.trim() : part.id
}

function partFamily(model: ModelState, part: PartInstance): string {
  const type = model.elements[part.typeId] as PartTypeElement | undefined
  return type?.kind === 'part_type' ? type.definition.familyName : 'Device'
}

function partRoom(model: ModelState, part: PartInstance): string {
  const r = roomOf(model.elements, part)
  return r ? (roomText(r) ?? '').trim() : ''
}

function normalizedLeg(part: PartInstance): string {
  return typeof part.values.switch_leg === 'string' ? part.values.switch_leg.trim().toLowerCase() : ''
}

function currentEmergencyMode(model: ModelState, part: PartInstance): EmergencyMode {
  const type = model.elements[part.typeId]
  const mode = part.values.emergency_mode ?? (type?.kind === 'part_type' ? type.definition.typeValues.emergency_mode : undefined)
  if (mode === 'unswitched' || mode === 'switched' || mode === 'none') return mode
  const em = part.values.emergency ?? (type?.kind === 'part_type' ? type.definition.typeValues.emergency : undefined)
  return em === true ? 'unswitched' : 'none'
}

function nextUnusedLeg(existing: readonly string[]): string {
  const set = new Set(existing)
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(97 + i)
    if (!set.has(ch)) return ch
  }
  return `z${existing.length + 1}`
}

function filterPartParams(model: ModelState, part: PartInstance, candidate: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const pt = model.elements[part.typeId]
  if (pt?.kind !== 'part_type') return candidate
  const allowed = new Set(pt.definition.instanceParams.map((p) => p.name))
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(candidate)) if (allowed.has(k)) out[k] = v
  return out
}

/**
 * Interactive Lighting & Receptacle Control Zone Manager:
 * - Pick any existing zone at the top (a, b, c, ...) or click "+ New zone"
 * - Visually add/remove Controllers (switches, dimmers, occupancy/daylight sensors)
 *   and Controlled Loads (luminaires, controlled receptacles) right inside the dialog
 * - Set the zone's control wiring protocol (Line voltage, 0-10V, DALI, Low voltage, Wireless)
 *   and fixture Emergency mode (Normal, Unswitched EM, UL 924 Switched EM)
 * - Highlight any zone directly on the plan with one click
 */
export function EditControlsDialog({
  model,
  selectedIds,
  submit,
  onSelect,
  onClose,
}: {
  readonly model: ModelState
  readonly selectedIds: readonly string[]
  readonly submit: SubmitCommand
  readonly onSelect: (ids: readonly string[]) => void
  readonly onClose: () => void
}) {
  const allControlParts = useMemo(
    () =>
      elementsOfKind(model.elements, 'part')
        .filter((e): e is PartInstance => e.planned === undefined && isControlCapablePart(model, e))
        .sort((a, b) => partMark(a).localeCompare(partMark(b))),
    [model],
  )

  const selectedParts = useMemo(
    () =>
      selectedIds
        .map((id) => model.elements[id])
        .filter((e): e is PartInstance => e?.kind === 'part' && isControlCapablePart(model, e)),
    [model, selectedIds],
  )

  const existingLegs = useMemo(() => {
    const s = new Set<string>()
    for (const p of allControlParts) {
      const l = normalizedLeg(p)
      if (l) s.add(l)
    }
    return [...s].sort()
  }, [allControlParts])

  const initialLeg = useMemo(() => {
    for (const p of selectedParts) {
      const l = normalizedLeg(p)
      if (l) return l
    }
    return existingLegs[0] ?? 'a'
  }, [selectedParts, existingLegs])

  const [leg, setLeg] = useState(initialLeg)
  const [creatingNew, setCreatingNew] = useState(false)
  const [newZoneDraft, setNewZoneDraft] = useState(() => nextUnusedLeg(existingLegs))
  const [error, setError] = useState<string | null>(null)
  // Staged membership overrides for the currently active zone: partId -> inZone (boolean)
  const [stagedMembers, setStagedMembers] = useState<Readonly<Record<string, boolean>>>(() => {
    // If the user opened Edit Controls with unassigned parts selected on the plan, pre-stage them into the active zone so one click applies!
    const init: Record<string, boolean> = {}
    for (const p of selectedParts) {
      if (!normalizedLeg(p)) init[p.id] = true
    }
    return init
  })

  const activeLeg = leg.trim().toLowerCase()

  const baseZoneMemberIds = useMemo(() => {
    const set = new Set<string>()
    if (!activeLeg) return set
    for (const p of allControlParts) {
      if (normalizedLeg(p) === activeLeg) set.add(p.id)
    }
    return set
  }, [allControlParts, activeLeg])

  const isInActiveZone = (id: string): boolean => (id in stagedMembers ? Boolean(stagedMembers[id]) : baseZoneMemberIds.has(id))

  const effectiveMembers = useMemo(
    () => allControlParts.filter((p) => isInActiveZone(p.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allControlParts, stagedMembers, baseZoneMemberIds],
  )

  const initialProtocolForZone = (targetLeg: string): ControlType => {
    const members = allControlParts.filter((p) => normalizedLeg(p) === targetLeg)
    for (const p of [...selectedParts, ...members]) {
      const v = p.values.control_type
      if (typeof v === 'string' && (CONTROL_TYPES as readonly string[]).includes(v) && v !== 'line_voltage') return v as ControlType
    }
    for (const p of [...selectedParts, ...members]) {
      const v = p.values.control_type
      if (typeof v === 'string' && (CONTROL_TYPES as readonly string[]).includes(v)) return v as ControlType
    }
    return 'line_voltage'
  }

  const initialEmergencyForZone = (targetLeg: string): EmergencyMode => {
    const firstLight = selectedParts.find((p) => isLightingPart(model, p)) ?? allControlParts.find((p) => normalizedLeg(p) === targetLeg && isLightingPart(model, p))
    return firstLight ? currentEmergencyMode(model, firstLight) : 'none'
  }

  const [protocol, setProtocol] = useState<ControlType>(() => initialProtocolForZone(initialLeg))
  const [protocolTouched, setProtocolTouched] = useState(false)
  const [emergencyMode, setEmergencyMode] = useState<EmergencyMode>(() => initialEmergencyForZone(initialLeg))
  const [emergencyTouched, setEmergencyTouched] = useState(false)

  const switchToZone = (nextLeg: string) => {
    const norm = nextLeg.trim().toLowerCase()
    setLeg(norm)
    setCreatingNew(false)
    setStagedMembers({})
    setProtocol(initialProtocolForZone(norm))
    setProtocolTouched(false)
    setEmergencyMode(initialEmergencyForZone(norm))
    setEmergencyTouched(false)
    setError(null)
  }

  const confirmNewZone = () => {
    const clean = newZoneDraft.trim().toLowerCase()
    if (!clean) return
    setLeg(clean)
    setCreatingNew(false)
    // Pre-stage any currently selected parts into the newly created zone.
    const nextStaged: Record<string, boolean> = {}
    for (const p of selectedParts) nextStaged[p.id] = true
    setStagedMembers(nextStaged)
    setProtocol('line_voltage')
    setProtocolTouched(true)
    setEmergencyTouched(false)
    setError(null)
  }

  const toggleMember = (partId: string) => {
    const currentlyIn = isInActiveZone(partId)
    setStagedMembers((prev) => ({ ...prev, [partId]: !currentlyIn }))
  }

  const addSelectedToZone = () => {
    setStagedMembers((prev) => {
      const next = { ...prev }
      for (const p of selectedParts) next[p.id] = true
      return next
    })
  }

  const allControllers = useMemo(() => allControlParts.filter((p) => isControllerPart(model, p)), [allControlParts, model])
  const allLoads = useMemo(() => allControlParts.filter((p) => !isControllerPart(model, p)), [allControlParts, model])
  const activeControllers = effectiveMembers.filter((p) => isControllerPart(model, p))
  const activeLoads = effectiveMembers.filter((p) => !isControllerPart(model, p))
  const hasAnyLightingTarget = activeLoads.some((p) => isLightingPart(model, p)) || selectedParts.some((p) => isLightingPart(model, p))

  // Compute pending edits count so Save button gives clear feedback.
  const memberDiffIds = useMemo(() => {
    const added: PartInstance[] = []
    const removed: PartInstance[] = []
    for (const p of allControlParts) {
      const wasIn = baseZoneMemberIds.has(p.id)
      const nowIn = isInActiveZone(p.id)
      if (!wasIn && nowIn) added.push(p)
      else if (wasIn && !nowIn) removed.push(p)
    }
    return { added, removed }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allControlParts, baseZoneMemberIds, stagedMembers])

  const hasPendingChanges = memberDiffIds.added.length > 0 || memberDiffIds.removed.length > 0 || protocolTouched || emergencyTouched

  const saveZone = () => {
    setError(null)
    if (!activeLeg) {
      setError('Pick or create a zone letter first (e.g. a, b, c).')
      return
    }
    // 1. Remove devices taken out of this zone.
    for (const part of memberDiffIds.removed) {
      const values = filterPartParams(model, part, { switch_leg: '' })
      if (Object.keys(values).length === 0) continue
      const refusal = submit({ type: 'set_parameters', id: part.id, scope: 'instance', values }, `remove ${partMark(part)} from zone ${activeLeg.toUpperCase()}`)
      if (refusal) {
        setError(refusal)
        return
      }
    }
    // 2. Apply zone assignment + protocol to added devices (and protocol to all existing zone members if touched).
    const toUpdate = protocolTouched ? effectiveMembers : memberDiffIds.added
    const touchedIds = new Set<string>()
    for (const part of toUpdate) {
      touchedIds.add(part.id)
      const candidate: Record<string, string | number | boolean> = {
        switch_leg: activeLeg,
        control_type: protocol,
      }
      if (emergencyTouched && isLightingPart(model, part)) {
        candidate.emergency = emergencyMode !== 'none'
        candidate.emergency_mode = emergencyMode
      }
      const values = filterPartParams(model, part, candidate)
      if (Object.keys(values).length === 0) continue
      const refusal = submit({ type: 'set_parameters', id: part.id, scope: 'instance', values }, `update control zone ${activeLeg.toUpperCase()}`)
      if (refusal) {
        setError(refusal)
        return
      }
    }
    // 3. Apply emergency mode to selected/zone luminaires if emergency was edited directly.
    if (emergencyTouched) {
      const emTargets = selectedParts.some((p) => isLightingPart(model, p))
        ? selectedParts.filter((p) => isLightingPart(model, p))
        : activeLoads.filter((p) => isLightingPart(model, p))
      for (const part of emTargets) {
        if (touchedIds.has(part.id)) continue
        const values = filterPartParams(model, part, {
          emergency: emergencyMode !== 'none',
          emergency_mode: emergencyMode,
        })
        if (Object.keys(values).length === 0) continue
        const refusal = submit({ type: 'set_parameters', id: part.id, scope: 'instance', values }, `set emergency mode on ${partMark(part)}`)
        if (refusal) {
          setError(refusal)
          return
        }
      }
    }
    onClose()
  }

  const clearWholeZone = () => {
    setError(null)
    for (const part of allControlParts) {
      if (!baseZoneMemberIds.has(part.id)) continue
      const values = filterPartParams(model, part, { switch_leg: '' })
      if (Object.keys(values).length === 0) continue
      const refusal = submit({ type: 'set_parameters', id: part.id, scope: 'instance', values }, `clear control zone ${activeLeg.toUpperCase()}`)
      if (refusal) {
        setError(refusal)
        return
      }
    }
    onClose()
  }

  const zoneCounts = useMemo(() => {
    const counts = new Map<string, { controllers: number; loads: number; rooms: Set<string> }>()
    for (const p of allControlParts) {
      const l = normalizedLeg(p)
      if (!l) continue
      const rec = counts.get(l) ?? { controllers: 0, loads: 0, rooms: new Set<string>() }
      if (isControllerPart(model, p)) rec.controllers += 1
      else rec.loads += 1
      const rm = partRoom(model, p)
      if (rm) rec.rooms.add(rm)
      counts.set(l, rec)
    }
    return counts
  }, [allControlParts, model])

  const allZoneKeys = useMemo(() => {
    const s = new Set(existingLegs)
    if (activeLeg) s.add(activeLeg)
    return [...s].sort()
  }, [existingLegs, activeLeg])

  const renderDeviceRow = (part: PartInstance) => {
    const inZone = isInActiveZone(part.id)
    const otherLeg = normalizedLeg(part)
    const inAnotherZone = !inZone && otherLeg !== '' && otherLeg !== activeLeg
    const rm = partRoom(model, part)
    const em = isLightingPart(model, part) ? currentEmergencyMode(model, part) : 'none'
    return (
      <Button
        key={part.id}
        type="button"
        variant="ghost"
        onClick={() => toggleMember(part.id)}
        className={`flex h-auto w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs font-normal transition-colors ${
          inZone
            ? 'border-primary/60 bg-primary/10 text-foreground hover:bg-primary/15'
            : 'border-border/60 bg-background hover:bg-muted/50 text-muted-foreground'
        }`}
        data-testid={`controls-member-${part.id}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground truncate">{partMark(part)}</span>
            {em !== 'none' && (
              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                {em === 'switched' ? 'UL924' : 'EM'}
              </Badge>
            )}
            {inAnotherZone && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                Zone {otherLeg.toUpperCase()}
              </Badge>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {partFamily(model, part)}
            {rm ? ` · ${rm}` : ''}
          </div>
        </div>
        <span
          className={`flex size-4 shrink-0 items-center justify-center rounded border ${
            inZone ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
          }`}
        >
          {inZone ? <Check className="size-3" /> : null}
        </span>
      </Button>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="edit-controls-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ToggleLeft className="size-4" />
            Lighting &amp; Receptacle Control Zones
          </DialogTitle>
          <DialogDescription>
            Pick a zone below (or create a new one), toggle which switches/sensors and fixtures belong to it, and set its control wiring protocol and emergency mode.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <CircleAlert className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Step 1: Zone selector bar */}
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel>1. Select control zone</FieldLabel>
              {selectedParts.length > 0 && (
                <Button type="button" size="sm" variant="outline" onClick={addSelectedToZone} className="h-6 text-xs">
                  Add {selectedParts.length} selected on plan to Zone {activeLeg.toUpperCase()}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-1" data-testid="controls-zone-picker">
              {allZoneKeys.map((z) => {
                const info = zoneCounts.get(z)
                const isSelected = z === activeLeg
                const roomHint = info ? [...info.rooms][0] : undefined
                return (
                  <Button
                    key={z}
                    type="button"
                    size="sm"
                    variant={isSelected ? 'default' : 'outline'}
                    onClick={() => switchToZone(z)}
                    className="h-8 gap-1.5 text-xs"
                    data-testid={`controls-zone-btn-${z}`}
                  >
                    <span className="font-semibold">Zone {z.toUpperCase()}</span>
                    {info ? (
                      <span className={isSelected ? 'opacity-85' : 'text-muted-foreground'}>
                        ({info.controllers}→{info.loads}
                        {roomHint ? ` · ${roomHint}` : ''})
                      </span>
                    ) : (
                      <span className={isSelected ? 'opacity-85' : 'text-muted-foreground'}>(new)</span>
                    )}
                  </Button>
                )
              })}
              {creatingNew ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={newZoneDraft}
                    onChange={(e) => setNewZoneDraft(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && confirmNewZone()}
                    placeholder="f"
                    maxLength={8}
                    className="h-8 w-20 text-xs"
                    autoFocus
                    data-testid="controls-new-zone-input"
                  />
                  <Button type="button" size="sm" className="h-8 px-2 text-xs" onClick={confirmNewZone}>
                    Create
                  </Button>
                  <Button type="button" size="sm" variant="ghost" className="h-8 px-1.5" onClick={() => setCreatingNew(false)}>
                    <X className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1 border border-dashed text-xs"
                  onClick={() => {
                    setNewZoneDraft(nextUnusedLeg(allZoneKeys))
                    setCreatingNew(true)
                  }}
                  data-testid="controls-new-zone-btn"
                >
                  <Plus className="size-3.5" />
                  New zone
                </Button>
              )}
            </div>
          </Field>

          {/* Step 2: Controllers & Controlled Loads checklist */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 rounded-md border p-2.5">
              <div className="flex items-center justify-between text-xs font-medium">
                <span>2a. Controllers in Zone {activeLeg.toUpperCase()}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {activeControllers.length} assigned
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">Click any switch, dimmer, or sensor to add/remove it.</p>
              <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-0.5">
                {allControllers.length > 0 ? allControllers.map(renderDeviceRow) : <p className="py-3 text-center text-xs text-muted-foreground">No switches or sensors placed yet.</p>}
              </div>
            </div>

            <div className="flex flex-col gap-1.5 rounded-md border p-2.5">
              <div className="flex items-center justify-between text-xs font-medium">
                <span>2b. Controlled loads in Zone {activeLeg.toUpperCase()}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {activeLoads.length} assigned
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">Click any luminaire or controlled receptacle to add/remove it.</p>
              <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-0.5">
                {allLoads.length > 0 ? allLoads.map(renderDeviceRow) : <p className="py-3 text-center text-xs text-muted-foreground">No fixtures or loads placed yet.</p>}
              </div>
            </div>
          </div>

          {/* Step 3: Protocol & Emergency settings */}
          <div className="grid grid-cols-1 gap-3 rounded-md border bg-muted/20 p-3">
            <Field>
              <FieldLabel>3. Control wiring protocol (Zone {activeLeg.toUpperCase()})</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                value={protocol}
                onValueChange={(v) => {
                  if (v && (CONTROL_TYPES as readonly string[]).includes(v)) {
                    setProtocol(v as ControlType)
                    setProtocolTouched(true)
                  }
                }}
                aria-label="Control wiring protocol"
                data-testid="edit-controls-protocol"
                className="flex flex-wrap justify-start"
              >
                {CONTROL_TYPES.map((ct) => (
                  <ToggleGroupItem key={ct} value={ct} className="text-xs">
                    {CONTROL_PROTOCOL_LABELS[ct]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>
                Line voltage draws dashed switch legs; 0-10V, DALI, and low-voltage controls draw dash-dot lines with conductor hash marks and feed the Lighting Controls Schedule &amp; Controls Diagram.
              </FieldDescription>
            </Field>

            {hasAnyLightingTarget && (
              <Field>
                <FieldLabel>Emergency fixture mode</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={emergencyMode}
                  onValueChange={(v) => {
                    if (v === 'none' || v === 'unswitched' || v === 'switched') {
                      setEmergencyMode(v)
                      setEmergencyTouched(true)
                    }
                  }}
                  aria-label="Emergency lighting mode"
                  data-testid="edit-controls-emergency"
                  className="flex flex-wrap justify-start"
                >
                  {EMERGENCY_MODES.map((m) => (
                    <ToggleGroupItem key={m.value} value={m.value} className="text-xs">
                      {m.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldDescription>{EMERGENCY_MODES.find((m) => m.value === emergencyMode)?.hint}</FieldDescription>
              </Field>
            )}
          </div>
        </div>

        <DialogFooter className="flex flex-wrap items-center justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-1.5">
            {effectiveMembers.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onSelect(effectiveMembers.map((p) => p.id))
                  onClose()
                }}
                data-testid="edit-controls-select-zone"
              >
                <MousePointerClick className="mr-1.5 size-3.5" />
                Highlight Zone {activeLeg.toUpperCase()} ({effectiveMembers.length})
              </Button>
            )}
            {baseZoneMemberIds.size > 0 && (
              <Button type="button" size="sm" variant="ghost" onClick={clearWholeZone} className="text-destructive hover:text-destructive">
                <Trash2 className="mr-1 size-3.5" />
                Clear zone
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={saveZone} disabled={!hasPendingChanges} data-testid="edit-controls-apply">
              <Save className="mr-1.5 size-3.5" />
              Save Zone {activeLeg.toUpperCase()}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
