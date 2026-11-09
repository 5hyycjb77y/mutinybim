'use client'

import { useState } from 'react'
import { SquareDashed, Trash2 } from 'lucide-react'
import type { MountingPlane, Vec2 } from '@permitzip/bim-kernel'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../ui/field'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { MM_PER_FT } from './placement'

const ftText = (mm: number) => String(Math.round((mm / MM_PER_FT) * 100) / 100)

interface LevelChoice {
  readonly id: string
  readonly name: string
}

/**
 * Model › Datum › Mounting plane: a level surface at a height above a level,
 * to place air devices on where there is no ceiling. It starts around the
 * level's work; the person names it, sets its height and can change the
 * corners. Esc or Cancel closes; nothing is saved until Add plane.
 */
export function MountingPlaneDialog({
  levels,
  initialLevelId,
  rectFor,
  onCancel,
  onAdd,
}: {
  readonly levels: readonly LevelChoice[]
  readonly initialLevelId: string | null
  readonly rectFor: (levelId: string) => { readonly corner1: Vec2; readonly corner2: Vec2 }
  readonly onCancel: () => void
  readonly onAdd: (levelId: string, name: string, heightMm: number, corner1: Vec2, corner2: Vec2) => string | null
}) {
  const first = initialLevelId ?? levels[0]?.id ?? ''
  const startRect = first ? rectFor(first) : { corner1: { x: 0, y: 0 }, corner2: { x: 0, y: 0 } }
  const [levelId, setLevelId] = useState(first)
  const [name, setName] = useState('Mounting plane 9\'-0"')
  const [height, setHeight] = useState('9')
  const [corners, setCorners] = useState({ x1: ftText(startRect.corner1.x), y1: ftText(startRect.corner1.y), x2: ftText(startRect.corner2.x), y2: ftText(startRect.corner2.y) })
  const [error, setError] = useState<string | null>(null)
  const pickLevel = (id: string) => {
    setLevelId(id)
    const r = rectFor(id)
    setCorners({ x1: ftText(r.corner1.x), y1: ftText(r.corner1.y), x2: ftText(r.corner2.x), y2: ftText(r.corner2.y) })
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const nums = [height, corners.x1, corners.y1, corners.x2, corners.y2].map(Number)
    if (!levelId) return setError('Add a level first: a mounting plane sits on a level.')
    if (name.trim() === '') return setError('Give the plane a name, for example "Open office 9\'-0"".')
    if (nums.some((n) => !Number.isFinite(n))) return setError('Height and corners are numbers of feet.')
    const [h, x1, y1, x2, y2] = nums.map((n) => n * MM_PER_FT)
    const refused = onAdd(levelId, name.trim(), h ?? 0, { x: x1 ?? 0, y: y1 ?? 0 }, { x: x2 ?? 0, y: y2 ?? 0 })
    if (refused) setError(refused)
  }
  const corner = (key: keyof typeof corners, label: string) => (
    <Field>
      <FieldLabel htmlFor={`bm-plane-${key}`}>{label}</FieldLabel>
      <Input id={`bm-plane-${key}`} inputMode="decimal" value={corners[key]} onChange={(e) => setCorners({ ...corners, [key]: e.target.value })} />
    </Field>
  )
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="mounting-plane-dialog">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a mounting plane</DialogTitle>
            <DialogDescription>A flat surface at a height above a level, to place diffusers and grilles on where there is no ceiling. Parts placed on it move with it.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-3">
            <FieldGroup className="grid grid-cols-2 gap-2">
              <Field>
                <FieldLabel htmlFor="bm-plane-level">Level</FieldLabel>
                <Select value={levelId || undefined} onValueChange={pickLevel}>
                  <SelectTrigger id="bm-plane-level" size="sm">
                    <SelectValue placeholder="Choose a level" />
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
                <FieldLabel htmlFor="bm-plane-height">Height above the level (ft)</FieldLabel>
                <Input id="bm-plane-height" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} data-testid="mounting-plane-height" />
              </Field>
            </FieldGroup>
            <Field>
              <FieldLabel htmlFor="bm-plane-name">Name</FieldLabel>
              <Input id="bm-plane-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="mounting-plane-name" />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Covers (plan corners, ft)</FieldLegend>
              <FieldDescription>Starts around the work on this level, 5 ft out. Change it to the room the devices go in.</FieldDescription>
              <FieldGroup className="grid grid-cols-4 gap-2">
                {corner('x1', 'West x')}
                {corner('y1', 'South y')}
                {corner('x2', 'East x')}
                {corner('y2', 'North y')}
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
          {error && (
            <FieldDescription className="text-danger-600" role="alert">
              {error}
            </FieldDescription>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" data-testid="mounting-plane-add">
              <SquareDashed data-icon="inline-start" />
              Add plane
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** A selected mounting plane: rename it, or move it up or down with the parts on it. */
export function MountingPlaneProperties({
  plane,
  levelName,
  partsOnIt,
  canEdit,
  onSave,
  onDelete,
}: {
  readonly plane: MountingPlane
  readonly levelName: string
  readonly partsOnIt: number
  readonly canEdit: boolean
  readonly onSave: (change: { name?: string; heightMm?: number }) => string | null
  readonly onDelete: () => void
}) {
  const [name, setName] = useState(plane.name)
  const [height, setHeight] = useState(ftText(plane.heightMm))
  const [error, setError] = useState<string | null>(null)
  const dirty = name !== plane.name || height !== ftText(plane.heightMm)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const ft = Number(height)
    if (!Number.isFinite(ft)) return setError('Height is a number of feet.')
    const change = { ...(name !== plane.name ? { name: name.trim() } : {}), ...(height !== ftText(plane.heightMm) ? { heightMm: ft * MM_PER_FT } : {}) }
    setError(onSave(change))
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3" data-testid="mounting-plane-properties">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{plane.name}</span>
        <span className="text-xs text-muted-foreground">
          Mounting plane · {levelName} · {partsOnIt === 1 ? '1 part on it' : `${partsOnIt} parts on it`}
        </span>
      </div>
      <FieldGroup className="gap-2">
        <Field>
          <FieldLabel htmlFor="bm-plane-edit-name">Name</FieldLabel>
          <Input id="bm-plane-edit-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
        </Field>
        <Field>
          <FieldLabel htmlFor="bm-plane-edit-height">Height above {levelName} (ft)</FieldLabel>
          <Input id="bm-plane-edit-height" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} disabled={!canEdit} data-testid="mounting-plane-edit-height" />
          {partsOnIt > 0 && <FieldDescription>Changing the height moves the {partsOnIt === 1 ? 'part' : 'parts'} on it; connected duct follows.</FieldDescription>}
        </Field>
      </FieldGroup>
      {error && (
        <FieldDescription className="text-danger-600" role="alert">
          {error}
        </FieldDescription>
      )}
      <Button type="submit" size="sm" disabled={!canEdit || !dirty}>
        Save changes
      </Button>
      <Button type="button" variant="outline" size="sm" className="text-danger-600" onClick={onDelete} disabled={!canEdit}>
        <Trash2 data-icon="inline-start" />
        Delete…
      </Button>
    </form>
  )
}
