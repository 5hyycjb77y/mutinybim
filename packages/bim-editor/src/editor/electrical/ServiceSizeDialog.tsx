'use client'

import { useMemo, useState, type ChangeEvent } from 'react'
import { CircleAlert, Gauge, ListRestart, Network } from 'lucide-react'
import { LOAD_CLASSES, modelLoadListText, modelLoadRows, parseEquipmentList, serviceCushionReading, serviceSize, type LoadClass, type ParsedEquipment } from '@permitzip/bim-pack-electrical'
import type { ModelState } from '@permitzip/bim-kernel'
import { Alert, AlertDescription, AlertTitle } from '../../ui/alert'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '../../ui/table'
import { Textarea } from '../../ui/textarea'
import type { NecRules } from './use-nec-rules'
import type { ServiceLayoutSeed } from './ServiceLayoutDialog'
import { CapacityTargetLine } from './CapacityTargetLine'
import type { CapacityTargets } from './use-capacity-targets'

const SYSTEMS = {
  '208-3': { voltage: 208, phases: 3, label: '120/208 V 3-phase', service: '208Y/120' },
  '480-3': { voltage: 480, phases: 3, label: '277/480 V 3-phase', service: '480Y/277' },
  '240-1': { voltage: 240, phases: 1, label: '120/240 V single-phase', service: '120/240' },
} as const
type SystemKey = keyof typeof SYSTEMS
const SYSTEM_KEYS: readonly SystemKey[] = ['208-3', '480-3', '240-1']
const isSystem = (v: string): v is SystemKey => SYSTEM_KEYS.some((k) => k === v)

const CLASS_WORD: Record<LoadClass, string> = { lighting: 'Lighting', receptacle: 'Receptacles', kitchen: 'Kitchen (220.56)', motor: 'Motor', hvac: 'HVAC', heating: 'Heating', cooling: 'Cooling', other: 'Other (100%)' }

/**
 * Electrical › Service size: before any layout, paste the kitchen
 * consultant's equipment schedule and the mechanical list (from a
 * spreadsheet, a CSV, or text copied out of a PDF). Each row shows its load
 * in VA, how it was read, and a suggested NEC load class from its words;
 * change any class that's wrong. The service size and the Article 220 trail
 * update as you do. Nothing in the model changes until you press Start a
 * service layout. The agent's bim_service_from_equipment_list gives the same answer.
 *
 * Fill from the model writes the planned equipment (the Equipment list, rooftop
 * units) and the electrical estimates on spaces into the list as rows, so the
 * connected total here is the one the service's Load summary shows once they
 * are circuited (82 kW = 342 A at 240 V on 7303).
 */
export function ServiceSizeDialog({ nec, model, onClose, onStartLayout, capacityTargets, canEdit = false }: { readonly nec: NecRules; readonly model?: ModelState | null; readonly onClose: () => void; readonly onStartLayout?: (seed: ServiceLayoutSeed) => void; readonly capacityTargets?: CapacityTargets; readonly canEdit?: boolean }) {
  const [textIn, setTextIn] = useState('')
  const [system, setSystem] = useState<SystemKey>('208-3')
  const [spare, setSpare] = useState('0')
  const [classes, setClasses] = useState<ReadonlyMap<number, LoadClass>>(new Map())
  const [fileError, setFileError] = useState<string | null>(null)
  const [fillNote, setFillNote] = useState<string | null>(null)
  const sys = SYSTEMS[system]
  const fromModel = useMemo(() => (model ? modelLoadRows(model) : []), [model])
  const fill = () => {
    setTextIn(modelLoadListText(fromModel))
    setClasses(new Map())
    const planned = fromModel.filter((r) => r.from === 'planned item').length
    setFillNote(`Filled from the model: ${planned} planned item${planned === 1 ? '' : 's'} and ${fromModel.length - planned} estimate${fromModel.length - planned === 1 ? '' : 's'}. Edit any row; the model doesn't change.`)
  }
  const rows = useMemo<ParsedEquipment[]>(() => (nec.necEdition && textIn.trim() ? parseEquipmentList(nec.necEdition, textIn, { voltageV: sys.voltage, phases: sys.phases }) : []), [nec.necEdition, textIn, sys])
  const sparePct = Math.min(100, Math.max(0, Number(spare) || 0))
  const usable = rows.filter((r) => r.va !== null && r.va > 0)
  const result = useMemo(() => {
    if (!nec.necEdition || usable.length === 0) return null
    return serviceSize(nec.necEdition, { voltage_v: sys.voltage, phases: sys.phases, occupancy: 'other', spare_pct: sparePct, items: usable.map((r) => ({ label: [r.tag, r.description].filter(Boolean).join(' '), class: classes.get(r.line) ?? r.suggestedClass, va: r.va ?? 0, quantity: r.quantity })) })
  }, [nec.necEdition, usable, sys, sparePct, classes])
  const problems = rows.filter((r) => r.problem)

  const openFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileError(null)
    file
      .text()
      .then((t) => setTextIn(t))
      .catch((err: unknown) => {
        console.error('[ServiceSizeDialog] reading the file failed', { name: file.name, err })
        setFileError(`Couldn't read ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-4xl" data-testid="service-size-dialog">
        <DialogHeader>
          <DialogTitle>Service size from an equipment list</DialogTitle>
          <DialogDescription>Paste the kitchen and mechanical schedules (from a spreadsheet, a CSV, or text copied out of a PDF). Check each row&apos;s load class; the size follows NEC Article 220. Nothing in the model changes.</DialogDescription>
        </DialogHeader>
        {!nec.necEdition && (
          <Alert>
            <CircleAlert />
            <AlertTitle>No NEC edition</AlertTitle>
            <AlertDescription>{nec.label}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-3">
          <Field className="min-w-48 flex-1">
            <FieldLabel htmlFor="bm-service-system">Service</FieldLabel>
            <Select value={system} onValueChange={(v) => isSystem(v) && setSystem(v)}>
              <SelectTrigger id="bm-service-system" data-testid="service-system">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {SYSTEM_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {SYSTEMS[k].label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field className="w-36">
            <FieldLabel htmlFor="bm-service-spare">Spare capacity (%)</FieldLabel>
            <Input id="bm-service-spare" type="number" min={0} max={100} value={spare} onChange={(e) => setSpare(e.target.value)} data-testid="service-spare" />
          </Field>
          <Field className="min-w-56 flex-1">
            <FieldLabel htmlFor="bm-service-file">Or open a CSV or text file</FieldLabel>
            <Input id="bm-service-file" type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onChange={openFile} data-testid="service-file" />
            {fileError && (
              <FieldDescription className="text-danger-600" role="alert">
                {fileError}
              </FieldDescription>
            )}
          </Field>
        </div>
        {model !== undefined && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={fill} disabled={fromModel.length === 0} title={fromModel.length === 0 ? 'Nothing to fill yet: add planned equipment (Equipment list) or an estimate on a space first.' : 'Replace the list with the planned equipment and estimates already in the model'} data-testid="service-fill-from-model">
              <ListRestart data-icon="inline-start" />
              Fill from the model{fromModel.length > 0 ? ` (${fromModel.length})` : ''}
            </Button>
            {fromModel.length === 0 ? (
              <FieldDescription>Nothing planned or estimated in the model yet: add planned equipment (Equipment list) or an estimate on a space first.</FieldDescription>
            ) : (
              fillNote && <FieldDescription data-testid="service-fill-note">{fillNote}</FieldDescription>
            )}
          </div>
        )}
        <Field>
          <FieldLabel htmlFor="bm-service-text">Equipment list</FieldLabel>
          <Textarea id="bm-service-text" rows={5} value={textIn} onChange={(e) => setTextIn(e.target.value)} placeholder={'K-10\tSandwich prep refrigerator\t1\t120\t1\t4.2 A\nK-14\tFryer, electric\t2\t208\t3\t17 kW'} data-testid="service-text" />
        </Field>
        {rows.length > 0 && (
          <div className="max-h-64 overflow-auto rounded-md border">
            <Table data-testid="service-rows">
              <TableCaption className="sr-only">Equipment read from the list</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Load</TableHead>
                  <TableHead>Class</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.line} data-testid="service-row">
                    <TableCell className="text-xs">
                      {r.tag && <span className="font-medium">{r.tag} </span>}
                      {r.description}
                      {r.problem && <span className="block text-danger-600">{r.problem}</span>}
                    </TableCell>
                    <TableCell className="text-xs">{r.quantity}</TableCell>
                    <TableCell className="text-xs">
                      {r.va === null ? '—' : `${r.va.toLocaleString('en-US')} VA`}
                      <span className="block text-muted-foreground">{r.vaBasis}</span>
                    </TableCell>
                    <TableCell className="text-xs">
                      <Select value={classes.get(r.line) ?? r.suggestedClass} onValueChange={(v) => { const c = LOAD_CLASSES.find((x) => x === v); if (c) setClasses(new Map([...classes, [r.line, c]])) }}>
                        <SelectTrigger size="sm" aria-label={`Load class of ${r.tag || r.description}`} data-testid={`service-class-${r.line}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {LOAD_CLASSES.map((c) => (
                              <SelectItem key={c} value={c}>
                                {CLASS_WORD[c]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <span className="block text-muted-foreground">{classes.has(r.line) ? 'you chose it' : r.classBasis}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {problems.length > 0 && <FieldDescription className="text-warning-700">{problems.length} row{problems.length === 1 ? '' : 's'} could not be read and are left out; fix them in the list.</FieldDescription>}
        {result && (
          <Alert data-testid="service-result">
            <Gauge />
            <AlertTitle>
              Service: {result.detail.label} ({Math.round(result.detail.requiredA)} A needed)
            </AlertTitle>
            <AlertDescription>
              <p className="font-medium" data-testid="service-connected">
                Connected (every load at 100%): {(result.detail.connectedVa / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kW = {Math.round(result.detail.connectedA)} A at {sys.voltage} V{sys.phases === 1 ? ' single-phase' : ' 3-phase'}
              </p>
              <CapacityTargetLine reading={serviceCushionReading({ demandA: result.detail.demand.sizingA, serviceA: result.detail.serviceA }, capacityTargets?.sources)} targets={capacityTargets} canEdit={canEdit} testId="service-cushion" />
              <ol className="list-decimal pl-4" data-testid="service-trail">
                {result.steps.map((s, i) => (
                  <li key={`${s.label}-${i}`}>
                    <span className="font-medium">{s.label}:</span> {s.detail}
                    {s.cite.length > 0 && <span className="text-muted-foreground"> ({s.cite.map((c) => c.text).join('; ')})</span>}
                  </li>
                ))}
              </ol>
              <p className="text-muted-foreground">An early estimate: confirm with the utility, and with the full calculation once the design has panels.</p>
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {onStartLayout && result?.detail.serviceA && (
            <Button onClick={() => result.detail.serviceA && onStartLayout({ serviceA: result.detail.serviceA, system: sys.service })} data-testid="service-start-layout">
              <Network data-icon="inline-start" />
              Start a {result.detail.serviceA} A service layout
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
