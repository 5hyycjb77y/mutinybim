'use client'

import { useMemo, useState } from 'react'
import { CircleAlert, RotateCcw } from 'lucide-react'
import {
  SYSTEM_LINE_PATTERNS,
  SYSTEM_LINE_WEIGHTS,
  SYSTEM_PATTERN_LABEL,
  SYSTEM_WEIGHT_LABEL,
  elementsOfKind,
  serviceLabel,
  systemStyle,
  type Command,
  type MepSystem,
  type ModelState,
  type PipeSizingMode,
  type SystemLinePattern,
  type SystemLineWeight,
} from '@permitzip/bim-kernel'
import { BUILDING_TYPE_LABEL, DEMAND_CURVE_LABEL, PLUMBING_BUILDING_TYPES, PLUMBING_DEMAND_CURVES, type PlumbingBuildingType, type PlumbingDemandCurve, type PipeInsulationRow, type PlumbingSettingsEntry, GAS_FUEL_LABEL, gasFuelOf, projectPlumbingSettings } from '@permitzip/bim-pack-plumbing'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../../ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Switch } from '../../ui/switch'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/tabs'
import type { SubmitCommand } from '../views-sheets/types'
import { PipeInsulationSchedule } from './PipeInsulationSchedule'

export type PlumbingSystemsTab = 'systems' | 'project' | 'insulation'

interface Props {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly tab: PlumbingSystemsTab
  readonly model: ModelState
  readonly editBlocked: string | null
  readonly submit: SubmitCommand
}

const PROJECT = '__project'
const BY_BUILDING = '__building'

/** The pipe systems in the model, by name. */
export function pipeSystems(model: Pick<ModelState, 'elements'>): readonly MepSystem[] {
  return elementsOfKind(model.elements, 'mep_system')
    .filter((s) => s.domain === 'pipe')
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The command that saves the project's plumbing settings with `patch` applied. */
export function projectSettingsCommand(
  current: PlumbingSettingsEntry,
  patch: { readonly sizingMode?: PipeSizingMode; readonly buildingType?: PlumbingBuildingType | null; readonly demandCurve?: PlumbingDemandCurve | null; readonly pipeInsulation?: readonly PipeInsulationRow[] | null; readonly pipeInsulationSource?: string | null },
): Command {
  const buildingType = patch.buildingType === undefined ? current.buildingType : (patch.buildingType ?? undefined)
  const demandCurve = patch.demandCurve === undefined ? current.demandCurve : (patch.demandCurve ?? undefined)
  const pipeInsulation = patch.pipeInsulation === undefined ? current.pipeInsulation : (patch.pipeInsulation ?? undefined)
  const pipeInsulationSource = patch.pipeInsulationSource === undefined ? current.pipeInsulationSource : (patch.pipeInsulationSource ?? undefined)
  return {
    type: 'save_catalog_entry',
    entry: {
      type: 'plumbing_settings',
      name: 'Project',
      sizingMode: patch.sizingMode ?? current.sizingMode,
      ...(buildingType ? { buildingType } : {}),
      ...(demandCurve ? { demandCurve } : {}),
      ...(pipeInsulation && pipeInsulation.length > 0 ? { pipeInsulation: [...pipeInsulation] } : {}),
      ...(pipeInsulationSource ? { pipeInsulationSource } : {}),
    },
  }
}

/** Plumbing › Systems: each pipe system's look and sizing, and the project's auto-sizing and demand curve. */
export function PlumbingSystemsDialog({ open, onOpenChange, tab, model, editBlocked, submit }: Props) {
  const [current, setCurrent] = useState<PlumbingSystemsTab>(tab)
  const [error, setError] = useState<string | null>(null)
  const systems = useMemo(() => pipeSystems(model), [model])
  const settings = projectPlumbingSettings(model.elements)
  const send = (command: Command, label: string) => setError(submit(command, label))
  const canEdit = editBlocked === null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="plumbing-systems-dialog">
        <DialogHeader>
          <DialogTitle>Plumbing systems</DialogTitle>
          <DialogDescription>How each pipe system looks on screen and in print, and whether pipe sizes are only checked or applied as you model.</DialogDescription>
        </DialogHeader>
        {editBlocked && (
          <Alert>
            <CircleAlert />
            <AlertTitle>View only</AlertTitle>
            <AlertDescription>{editBlocked}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" data-testid="plumbing-systems-error">
            <CircleAlert />
            <AlertTitle>Not saved</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Tabs value={current} onValueChange={(v) => (v === 'systems' || v === 'project' || v === 'insulation') && setCurrent(v)}>
          <TabsList>
            <TabsTrigger value="systems">Systems</TabsTrigger>
            <TabsTrigger value="project">Project</TabsTrigger>
            <TabsTrigger value="insulation" data-testid="plumbing-insulation-tab">
              Insulation
            </TabsTrigger>
          </TabsList>
          <TabsContent value="systems">
            {systems.length === 0 ? (
              <Empty className="border py-4">
                <EmptyHeader>
                  <EmptyTitle>No pipe systems yet</EmptyTitle>
                  <EmptyDescription>Route pipe (Plumbing › Route pipe) and its system appears here, with its standard look: cold water blue dash-dot, vent dashed, gas long dash.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table data-testid="plumbing-systems-table">
                <TableCaption className="sr-only">Pipe systems</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>System</TableHead>
                    <TableHead>Colour</TableHead>
                    <TableHead>Lines</TableHead>
                    <TableHead>Weight</TableHead>
                    <TableHead>Auto-size</TableHead>
                    <TableHead>
                      <span className="sr-only">Standard look</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {systems.map((s) => (
                    <SystemRow key={s.id} system={s} projectMode={settings.sizingMode} canEdit={canEdit} send={send} />
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>
          <TabsContent value="project">
            <FieldGroup>
              <Field orientation="horizontal">
                <Switch id="plumbing-auto-size" checked={settings.sizingMode === 'auto'} disabled={!canEdit} onCheckedChange={(on) => send(projectSettingsCommand(settings, { sizingMode: on ? 'auto' : 'check' }), on ? 'turn auto-sizing on' : 'turn auto-sizing off')} data-testid="plumbing-project-auto-size" />
                <FieldLabel htmlFor="plumbing-auto-size">Auto-size pipes</FieldLabel>
                <FieldDescription>{settings.sizingMode === 'auto' ? 'On: suggested sizes apply as you model, except on systems set to check.' : 'Off: every pipe is checked and sizes are suggested; nothing changes until you accept.'}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="plumbing-building-type">Building type</FieldLabel>
                <Select value={settings.buildingType ?? ''} disabled={!canEdit} onValueChange={(v) => (PLUMBING_BUILDING_TYPES as readonly string[]).includes(v) && send(projectSettingsCommand(settings, { buildingType: v as PlumbingBuildingType }), 'set the building type')}>
                  <SelectTrigger id="plumbing-building-type" size="sm" data-testid="plumbing-building-type">
                    <SelectValue placeholder="Choose (restaurant, office…)" />
                  </SelectTrigger>
                  <SelectContent>
                    {PLUMBING_BUILDING_TYPES.map((b) => (
                      <SelectItem key={b} value={b}>
                        {BUILDING_TYPE_LABEL[b]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Picks the demand curve unless you choose one: restaurant → ASHRAE Curve A, hospital or hotel → B, apartments → C, office or school → D.</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="plumbing-demand-curve">Demand curve</FieldLabel>
                <Select value={settings.demandCurve ?? BY_BUILDING} disabled={!canEdit} onValueChange={(v) => send(projectSettingsCommand(settings, { demandCurve: v === BY_BUILDING ? null : (v as PlumbingDemandCurve) }), 'set the demand curve')}>
                  <SelectTrigger id="plumbing-demand-curve" size="sm" data-testid="plumbing-project-demand-curve">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={BY_BUILDING}>From the building type</SelectItem>
                    {PLUMBING_DEMAND_CURVES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {DEMAND_CURVE_LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>How water supply fixture units become gpm when water pipes are sized. A system can use its own (Systems tab).</FieldDescription>
              </Field>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="insulation">
            <PipeInsulationSchedule
              model={model}
              settings={settings}
              systems={systems}
              canEdit={canEdit}
              send={send}
              saveSchedule={(rows, label, source) => send(projectSettingsCommand(settings, { pipeInsulation: rows, ...(source !== undefined ? { pipeInsulationSource: source } : {}) }), label)}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function SystemRow({ system, projectMode, canEdit, send }: { system: MepSystem; projectMode: PipeSizingMode; canEdit: boolean; send: (command: Command, label: string) => void }) {
  const style = systemStyle(system)
  const own = system.design?.pipe?.sizingMode
  const graphics = (patch: { colour?: string | null; pattern?: SystemLinePattern | null; weight?: SystemLineWeight | null }, label: string) => send({ type: 'set_system_graphics', systemId: system.id, ...patch }, `${label} on ${system.name}`)
  const custom = style.overridden.colour || style.overridden.pattern || style.overridden.weight
  const fuel = gasFuelOf(system)
  return (
    <TableRow data-testid={`plumbing-system-${system.id}`}>
      <TableCell>
        <div className="font-medium">{system.name}</div>
        {fuel ? (
          <Select
            value={fuel}
            disabled={!canEdit}
            onValueChange={(v) => {
              if (v !== 'natural' && v !== 'propane') return
              send({ type: 'set_system_design', systemId: system.id, design: { pipe: { gasType: v } } }, `set ${system.name} to ${GAS_FUEL_LABEL[v].toLowerCase()}`)
            }}
          >
            <SelectTrigger size="sm" className="mt-1" aria-label={`Gas on ${system.name}`} title="Sets the gas tables used to size this system and the word its labels, tags and schedules print" data-testid="plumbing-system-fuel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="natural">{GAS_FUEL_LABEL.natural}</SelectItem>
              <SelectItem value="propane">{GAS_FUEL_LABEL.propane}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <div className="text-xs text-muted-foreground">{serviceLabel(system.systemKind)}</div>
        )}
      </TableCell>
      <TableCell>
        <Input type="color" aria-label={`Colour of ${system.name}`} className="h-8 w-12 p-1" value={style.colour} disabled={!canEdit} onChange={(e) => graphics({ colour: e.target.value }, 'change the colour')} data-testid="plumbing-system-colour" />
      </TableCell>
      <TableCell>
        <Select value={style.pattern} disabled={!canEdit} onValueChange={(v) => (SYSTEM_LINE_PATTERNS as readonly string[]).includes(v) && graphics({ pattern: v as SystemLinePattern }, 'change the line pattern')}>
          <SelectTrigger size="sm" aria-label={`Line pattern of ${system.name}`} data-testid="plumbing-system-pattern">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SYSTEM_LINE_PATTERNS.map((p) => (
              <SelectItem key={p} value={p}>
                {SYSTEM_PATTERN_LABEL[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Select value={style.weight ?? 'standard'} disabled={!canEdit} onValueChange={(v) => graphics({ weight: v === 'standard' ? null : (v as SystemLineWeight) }, 'change the line weight')}>
          <SelectTrigger size="sm" aria-label={`Line weight of ${system.name}`} data-testid="plumbing-system-weight">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">Standard</SelectItem>
            {SYSTEM_LINE_WEIGHTS.map((w) => (
              <SelectItem key={w} value={w}>
                {SYSTEM_WEIGHT_LABEL[w]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Select
          value={own ?? PROJECT}
          disabled={!canEdit}
          onValueChange={(v) => {
            if (v !== PROJECT && v !== 'check' && v !== 'auto') return
            const sizingMode: PipeSizingMode | null = v === PROJECT ? null : v
            const design = { pipe: { sizingMode } }
            send({ type: 'set_system_design', systemId: system.id, design }, `auto-size ${system.name}`)
          }}
        >
          <SelectTrigger size="sm" aria-label={`Auto-size ${system.name}`} data-testid="plumbing-system-sizing">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROJECT}>As the project ({projectMode === 'auto' ? 'on' : 'off'})</SelectItem>
            <SelectItem value="check">Off: check only</SelectItem>
            <SelectItem value="auto">On: apply sizes</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="icon-sm" aria-label={`Standard look for ${system.name}`} title={custom ? 'Back to the standard look for this kind of system' : 'Already the standard look'} disabled={!canEdit || !custom} onClick={() => graphics({ colour: null, pattern: null, weight: null }, 'reset the look')}>
          <RotateCcw />
        </Button>
      </TableCell>
    </TableRow>
  )
}
