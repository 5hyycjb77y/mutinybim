'use client'

import { useMemo, useState } from 'react'
import { CircleAlert, SquareStack } from 'lucide-react'
import { type ModelState } from '@permitzip/bim-kernel'
import { circuitTemplateOf, circuitTemplates, distributionEquipment, planCircuitTemplate, suggestUnits, type TemplateUnit } from '@permitzip/bim-pack-electrical'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import type { SubmitCommand } from '../views-sheets/types'

const NO_PANEL = '__none__'

/**
 * Apply a room template to dwelling units. Units are the rooms grouped by
 * room number ("101-2" belongs to unit 101); you tick the units to circuit
 * and name each one's panel (a panel named after the unit is filled in;
 * nothing is chosen by distance). The preview shows every circuit the edit
 * will make, with the slots it takes, and why any can't be made. Apply saves
 * them as one undoable edit; Esc or Cancel closes with nothing changed.
 */
export function ApplyTemplateDialog({ model, initialTemplate, selectedIds, submit, onClose, onDone, onEditTemplates }: { readonly model: ModelState; readonly initialTemplate: string | null; readonly selectedIds: readonly string[]; readonly submit: SubmitCommand; readonly onClose: () => void; readonly onDone: (panelId: string | null) => void; readonly onEditTemplates: () => void }) {
  const els = model.elements
  const templates = useMemo(() => circuitTemplates(model), [model])
  const [templateName, setTemplateName] = useState(initialTemplate ?? templates[0]?.entry.name ?? '')
  const allRooms = useMemo(() => Object.values(els).flatMap((e) => (e.kind === 'room' ? [e.id] : [])), [els])
  const suggested = useMemo(() => suggestUnits(els, allRooms), [els, allRooms])
  const selected = useMemo(() => new Set(selectedIds), [selectedIds])
  const panels = useMemo(() => distributionEquipment(els).filter((d) => d.kind === 'panelboard'), [els])
  const [include, setInclude] = useState<ReadonlySet<string>>(() => new Set(suggested.filter((u) => u.roomIds.some((r) => selected.has(r))).map((u) => u.unit)))
  const [panelFor, setPanelFor] = useState<Readonly<Record<string, string>>>(() => Object.fromEntries(suggested.flatMap((u) => (u.panelId ? [[u.unit, u.panelId]] : []))))
  const [error, setError] = useState<string | null>(null)
  const template = templateName ? circuitTemplateOf(els, templateName) : null
  const chosen = suggested.filter((u) => include.has(u.unit))
  const missingPanel = chosen.find((u) => !panelFor[u.unit])
  const units = useMemo<TemplateUnit[]>(() => suggested.filter((u) => include.has(u.unit)).flatMap((u) => (panelFor[u.unit] ? [{ panelId: panelFor[u.unit] as string, roomIds: u.roomIds, label: `Unit ${u.unit}` }] : [])), [suggested, include, panelFor])
  const plan = useMemo(() => (template && units.length > 0 && !missingPanel ? planCircuitTemplate(model, template, units) : null), [model, template, units, missingPanel])
  const why = !template ? 'Choose a room template (make one in Electrical types › Room templates).' : chosen.length === 0 ? 'Tick the units to circuit.' : missingPanel ? `Choose the panel for unit ${missingPanel.unit}.` : plan && !plan.command ? plan.message : null

  const apply = () => {
    if (!plan?.command) return
    const refusal = submit(plan.command, `apply room template ${templateName}`)
    if (refusal) return setError(refusal)
    onDone(units[0]?.panelId ?? null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="apply-template-dialog">
        <DialogHeader>
          <DialogTitle>Circuit units by a room template</DialogTitle>
          <DialogDescription>The devices inside each room go on the circuit its rule names, on the panel you choose for the unit. Devices already on a circuit are left alone. You can undo this.</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="bm-template">Room template</FieldLabel>
          <Select value={templateName} onValueChange={setTemplateName}>
            <SelectTrigger id="bm-template" data-testid="apply-template-select">
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {templates.map((t) => (
                  <SelectItem key={t.entry.name} value={t.entry.name}>
                    {t.entry.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        {suggested.length === 0 ? (
          <Empty className="border py-4">
            <EmptyHeader>
              <EmptyTitle>No rooms in this model</EmptyTitle>
              <EmptyDescription>Rooms come from the architectural model. Link or import it, then come back.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="max-h-52 overflow-auto rounded-md border">
            <Table data-testid="apply-template-units">
              <TableCaption className="sr-only">Units to circuit</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Circuit</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Rooms</TableHead>
                  <TableHead>Panel</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suggested.map((u) => (
                  <TableRow key={u.unit}>
                    <TableCell>
                      <Checkbox aria-label={`Circuit unit ${u.unit}`} checked={include.has(u.unit)} onCheckedChange={(v) => setInclude(new Set(v === true ? [...include, u.unit] : [...include].filter((x) => x !== u.unit)))} />
                    </TableCell>
                    <TableCell className="text-xs font-medium">{u.unit}</TableCell>
                    <TableCell className="text-xs">{u.roomIds.map((r) => { const el = els[r]; return el?.kind === 'room' ? el.name || el.number : r }).join(', ')}</TableCell>
                    <TableCell>
                      <Select value={panelFor[u.unit] ?? NO_PANEL} onValueChange={(v) => setPanelFor({ ...panelFor, [u.unit]: v === NO_PANEL ? '' : v })}>
                        <SelectTrigger size="sm" aria-label={`Panel for unit ${u.unit}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value={NO_PANEL}>Choose the unit&apos;s panel</SelectItem>
                            {panels.map((p) => (
                              <SelectItem key={p.id} value={p.id}>
                                {p.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {plan && (
          <div className="max-h-56 overflow-auto rounded-md border">
            <Table data-testid="apply-template-preview">
              <TableCaption className="sr-only">Circuits it makes</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Rooms</TableHead>
                  <TableHead>Circuit</TableHead>
                  <TableHead>Devices</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.units.flatMap((u) =>
                  u.circuits.map((c) => (
                    <TableRow key={c.linkId} className={c.refusal ? 'text-muted-foreground' : undefined}>
                      <TableCell className="text-xs">{u.label}</TableCell>
                      <TableCell className="text-xs">{c.rooms.join(', ')}</TableCell>
                      <TableCell className="text-xs">{c.refusal ? <span className="text-danger-600">{c.refusal}</span> : `${c.name} ${c.description}`}</TableCell>
                      <TableCell className="text-xs">{c.memberIds.length}</TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
            {plan.units.some((u) => u.unmatchedRooms.length > 0) && <FieldDescription className="p-2 text-xs">No rule matched: {plan.units.flatMap((u) => u.unmatchedRooms.map((r) => `${r} (${u.label})`)).join(', ')}.</FieldDescription>}
          </div>
        )}
        {why ? (
          <Alert data-testid="apply-template-why">
            <CircleAlert />
            <AlertTitle>Not ready</AlertTitle>
            <AlertDescription>{why}</AlertDescription>
          </Alert>
        ) : (
          <FieldDescription data-testid="apply-template-summary">{plan?.message}</FieldDescription>
        )}
        {error && (
          <FieldDescription className="text-danger-600" role="alert">
            {error}
          </FieldDescription>
        )}
        <DialogFooter>
          <Button variant="ghost" className="mr-auto" onClick={onEditTemplates}>
            Edit templates
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={why !== null} title={why ?? undefined} data-testid="apply-template-apply">
            <SquareStack data-icon="inline-start" />
            Make {plan?.made ?? 0} circuit{plan?.made === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
