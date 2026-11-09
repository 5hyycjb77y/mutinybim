'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, Pencil, PencilRuler, RotateCw, Trash2 } from 'lucide-react'
import { partGroupName, type Command, type FacetRegistry, type ParamDef, type ParamValue, type PartInstance, type PartTypeDefinition } from '@permitzip/bim-kernel'
import type { DisplayProfile } from '@permitzip/bim-units'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '../../ui/field'
import { Input } from '../../ui/input'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../../ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Separator } from '../../ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { MM_PER_FT } from '../placement'
import type { LinkedSupply } from '../electrical/linked-supply'
import { builtinEquipmentParameters, declareOnType, type EquipmentParameter } from '../equipment-list/parameters'
import { displayText, inspectorSections, planParameterEdit, storedValue, type InspectorParameter, type InspectorSection } from './parameter-model'

export type SaveLabel = 'saved' | 'saving' | 'not_saved'

export interface PartInspectorProps {
  part: PartInstance
  type: PartTypeDefinition | null
  typeId: string
  levelName: string
  canEdit: boolean
  /** Where this person's edits stand on the server. */
  saving: SaveLabel
  saveMessage: string | null
  formatValue: (def: ParamDef | undefined, value: ParamValue) => string
  /** How many parts share the type (counted when Edit type opens). */
  partsOfType: () => number
  onInstance: (values: Record<string, ParamValue | null>, mark: string | undefined, dzMm: number) => string | null
  onType: (values: Record<string, ParamValue | null>) => string | null
  onRotate: (deg: number) => string | null
  onDelete: () => void
  /** Bumped by the ribbon's Edit type: opens the type editor as the button here does. */
  editTypeRequest?: number
  /** Open the part editor on this part's definition (modeled parts only). */
  onEditDefinition?: () => void
  /** Where it stands and the space it needs (PartSpaceProperties). */
  spatial?: ReactNode
  /** Mount, hoods and flex for air devices and equipment (PartAirSideFields). */
  airSide?: ReactNode
  /** What serves the part (a panel's feeder, a device's circuit), and the typed text when that names something else. */
  linkedSupply?: LinkedSupply | null
  /** Library fields (baseline, firm, project). Absent: the built-in baseline. */
  library?: readonly EquipmentParameter[]
  /** Any model command: declares a library field on the part's type before its first value. Absent: such fields are read-only, with the reason. */
  onCommand?: (command: Command) => string | null
  /** The unit profile values are shown in. Absent: each value in the unit the part stores it (lengths in feet). */
  profile?: DisplayProfile
  /** Facets the sections come from (built-in plus the firm's library rows). Absent: the built-in registry. */
  facets?: FacetRegistry
  /** Extra sections hosted below the parameters (an add-on's). */
  children?: ReactNode
}

const HEIGHT = '__height'
const MARK = '__mark'

/** The unit after a label: the v1 wording for a part's own number ("CFM", "V"), else the display unit. */
function unitLabel(p: InspectorParameter): string | null {
  if (p.def?.kind === 'length') return 'ft'
  if (p.def?.kind === 'number' && p.displayUnit === p.storedUnit) return p.def.unit && p.def.unit !== 'none' ? p.def.unit.toUpperCase() : null
  return p.displayUnit && p.displayUnit !== '1' ? p.displayUnit : null
}

function ParameterInput({ p, id, text, onText, disabled, why }: { p: InspectorParameter; id: string; text: string; onText: (t: string) => void; disabled: boolean; why?: string }) {
  const unit = unitLabel(p)
  if (p.valueType === 'boolean') {
    return (
      <Field orientation="horizontal" data-testid={`inspector-param-${p.name}`}>
        <Checkbox id={id} checked={text === 'true'} onCheckedChange={(v) => onText(v === true ? 'true' : 'false')} disabled={disabled} />
        <FieldLabel htmlFor={id} className="font-normal">
          {p.label}
        </FieldLabel>
        {why && <FieldDescription>{why}</FieldDescription>}
      </Field>
    )
  }
  if (p.valueType === 'choice' && p.choices) {
    return (
      <Field data-testid={`inspector-param-${p.name}`}>
        <FieldLabel htmlFor={id}>{p.label}</FieldLabel>
        <Select value={text || undefined} onValueChange={onText} disabled={disabled}>
          <SelectTrigger id={id} size="sm">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {p.choices.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {why && <FieldDescription>{why}</FieldDescription>}
      </Field>
    )
  }
  return (
    <Field data-testid={`inspector-param-${p.name}`}>
      <FieldLabel htmlFor={id}>
        {p.label}
        {unit ? ` (${unit})` : ''}
      </FieldLabel>
      <Input id={id} value={text} onChange={(e) => onText(e.target.value)} disabled={disabled} inputMode={p.valueType === 'quantity' ? 'decimal' : 'text'} />
      {why && <FieldDescription>{why}</FieldDescription>}
    </Field>
  )
}

const LINKED_COPY: Record<LinkedSupply['param'], { readonly testId: string; readonly from: string; readonly prints: string }> = {
  fed_from: { testId: 'part-fed-from', from: 'From its feeder. Change it with Feed panel.', prints: 'Schedules print the feeder.' },
  circuit: { testId: 'part-circuit', from: 'From its circuit. Change it with Add to circuit or the panel schedule.', prints: 'Schedules and tags print the circuit.' },
}

/** Fed from / Circuit, once a link serves the part: the link is the truth, so the typed text is shown only when it disagrees. */
function LinkedSupplyField({ label, supply, canEdit, onClear }: { readonly label: string; readonly supply: LinkedSupply; readonly canEdit: boolean; readonly onClear: () => void }) {
  const copy = LINKED_COPY[supply.param]
  return (
    <Field data-testid={`${copy.testId}-linked`}>
      <FieldLabel>{label}</FieldLabel>
      <p className="text-sm">{supply.text}</p>
      <FieldDescription>{copy.from}</FieldDescription>
      {supply.typedMismatch !== null && (
        <div className="flex flex-wrap items-center gap-2" role="alert" data-testid={`${copy.testId}-mismatch`}>
          <span className="text-xs text-warning-700">
            The typed {label} still says “{supply.typedMismatch}”. {copy.prints}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={onClear} disabled={!canEdit} title={canEdit ? undefined : "Live editing isn't connected, so changes can't be saved"}>
            Clear typed text
          </Button>
        </div>
      )}
    </Field>
  )
}

function feet(mm: number): string {
  return String(Math.round((mm / MM_PER_FT) * 1000) / 1000)
}

/** The texts the form starts from: every instance parameter and library field, the mark and the height. */
function initialTexts(part: PartInstance, type: PartTypeDefinition | null, sections: readonly InspectorSection[]): Record<string, string> {
  const out: Record<string, string> = { [MARK]: part.mark, [HEIGHT]: feet(part.offsetMm) }
  if (!type) return out
  for (const s of sections) for (const p of s.parameters) if (p.scope === 'instance') out[p.name] = displayText(p, storedValue(type, part, p))
  return out
}

const NOT_ON_TYPE = 'Not on this part’s type yet; it is added the first time you save a value. Live editing must be connected.'

/**
 * The Inspector for a part (NEXT-BATCH 5b-2): one form generated from the
 * part's parameter definitions, in one section per facet (identity,
 * electrical, gas, water, drainage, mechanical, structural, then the firm's
 * and the project's own groups). Firm and project fields appear with no code
 * change; a field the part's type doesn't hold yet is added to the type when
 * its first value is saved. Type values stay read-only behind Edit type.
 */
export function PartInspector(props: PartInspectorProps) {
  const { part, type, levelName, canEdit, saving, saveMessage, formatValue } = props
  const library = useMemo(() => props.library ?? builtinEquipmentParameters(), [props.library])
  const linked = props.linkedSupply?.param
  const sections = useMemo(() => (type ? inspectorSections(type, library, { ...(props.profile ? { profile: props.profile } : {}), ...(props.facets ? { facets: props.facets } : {}) }) : []), [type, library, props.profile, props.facets])
  const instanceSections = sections.map((s) => ({ ...s, parameters: s.parameters.filter((p) => p.scope === 'instance') })).filter((s) => s.parameters.length > 0)
  const typeSections = sections.map((s) => ({ ...s, parameters: s.parameters.filter((p) => p.scope === 'type') })).filter((s) => s.parameters.length > 0)
  const [texts, setTexts] = useState<Record<string, string>>(() => initialTexts(part, type, sections))
  const [error, setError] = useState<string | null>(null)
  const [typeOpen, setTypeOpen] = useState(false)
  const [sharedBy, setSharedBy] = useState(0)
  const handledEditType = useRef(props.editTypeRequest ?? 0)
  const { editTypeRequest, partsOfType } = props
  const canEditType = canEdit && type !== null && type.typeParams.length > 0
  useEffect(() => {
    if (!editTypeRequest || editTypeRequest === handledEditType.current) return
    handledEditType.current = editTypeRequest
    if (!canEditType) return
    setSharedBy(partsOfType())
    setTypeOpen(true)
  }, [editTypeRequest, partsOfType, canEditType])
  const baseline = initialTexts(part, type, sections)
  const dirty = Object.keys(texts).some((k) => texts[k] !== (baseline[k] ?? ''))
  const status: SaveLabel = dirty ? 'not_saved' : saving
  const allParams = instanceSections.flatMap((s) => s.parameters)

  const apply = (e: React.FormEvent) => {
    e.preventDefault()
    if (!type) return
    const plan = planParameterEdit(type, part, allParams, texts, 'instance')
    if ('problem' in plan) {
      setError(plan.problem)
      return
    }
    const markText = texts[MARK] ?? ''
    const mark = markText !== part.mark ? markText : undefined
    const heightFt = Number(texts[HEIGHT])
    if (!Number.isFinite(heightFt)) {
      setError('Height above the level must be a number of feet.')
      return
    }
    if (plan.declare.length > 0) {
      if (!props.onCommand) {
        setError(`${plan.declare.map((p) => p.label).join(', ')}: ${NOT_ON_TYPE}`)
        return
      }
      const declared = declareOnType(props.typeId, type, plan.declare)
      if ('refused' in declared) {
        setError(declared.refused)
        return
      }
      if (declared.command) {
        const refused = props.onCommand(declared.command)
        if (refused) {
          setError(refused)
          return
        }
      }
    }
    // The field shows the height rounded: untouched, it is no move (a rounding difference would move the part and take the undo).
    const dz = texts[HEIGHT] === baseline[HEIGHT] ? 0 : Math.round((heightFt * MM_PER_FT - part.offsetMm) * 1000) / 1000
    setError(props.onInstance(plan.values, mark, dz))
  }

  /** Built-in baseline fields the type doesn't hold yet wait behind "More …"; the firm's and the project's always show. */
  const isSpare = (p: InspectorParameter): boolean => !p.def && p.source === 'builtin'
  const input = (p: InspectorParameter) => {
    if (linked && p.name === linked && props.linkedSupply) {
      return <LinkedSupplyField key={p.name} label={p.label} supply={props.linkedSupply} canEdit={canEdit} onClear={() => setError(props.onInstance({ [p.name]: null }, undefined, 0))} />
    }
    const offType = !p.def
    const why = p.locked ?? (offType ? (props.onCommand ? 'Added to this part’s type when you save a value.' : NOT_ON_TYPE) : undefined)
    return <ParameterInput key={p.name} p={p} id={`bm-part-${p.name}`} text={texts[p.name] ?? ''} onText={(t) => setTexts({ ...texts, [p.name]: t })} disabled={!canEdit || p.locked !== undefined || (offType && !props.onCommand)} {...(why ? { why } : {})} />
  }

  const statusText = status === 'not_saved' ? 'Not saved yet: press Save changes.' : status === 'saving' ? 'Saving…' : (saveMessage ?? 'Saved')
  const editWhy = canEdit ? undefined : "Live editing isn't connected, so changes can't be saved"
  return (
    <div className="flex flex-col gap-3" data-testid="part-properties" data-inspector="parameters">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{part.mark ? `${part.mark} — ${type?.typeName ?? 'Part'}` : (type?.typeName ?? 'Part')}</span>
        <span className="text-xs text-muted-foreground">
          {type ? `${partGroupName(type)} · ` : ''}
          {levelName}
        </span>
        <span className={`text-xs ${status === 'not_saved' ? 'text-warning-700' : 'text-muted-foreground'}`} role="status" data-testid="part-save-state" data-state={status}>
          {statusText}
        </span>
      </div>
      <form onSubmit={apply} className="flex flex-col gap-3">
        <FieldSet data-testid="inspector-section-this-part">
          <FieldLegend variant="label">This part</FieldLegend>
          <FieldGroup className="grid grid-cols-2 gap-2">
            <Field>
              <FieldLabel htmlFor="bm-part-mark">Mark</FieldLabel>
              <Input id="bm-part-mark" value={texts[MARK] ?? ''} onChange={(e) => setTexts({ ...texts, [MARK]: e.target.value })} disabled={!canEdit} />
            </Field>
            <Field>
              <FieldLabel htmlFor="bm-part-height">Height above level (ft)</FieldLabel>
              <Input id="bm-part-height" inputMode="decimal" value={texts[HEIGHT] ?? ''} onChange={(e) => setTexts({ ...texts, [HEIGHT]: e.target.value })} disabled={!canEdit} />
            </Field>
          </FieldGroup>
        </FieldSet>
        {instanceSections.map((s) => (
          <FieldSet key={s.id} data-testid={`inspector-section-${s.id}`}>
            <FieldLegend variant="label">{s.label}</FieldLegend>
            <FieldGroup className="gap-2">{s.parameters.filter((p) => !isSpare(p)).map(input)}</FieldGroup>
            {s.parameters.some(isSpare) && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button type="button" variant="ghost" size="sm" className="self-start" data-testid={`inspector-more-${s.id}`}>
                    <ChevronDown data-icon="inline-start" />
                    More {s.label.toLowerCase()} fields ({s.parameters.filter(isSpare).length})
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <FieldGroup className="gap-2 pt-2">{s.parameters.filter(isSpare).map(input)}</FieldGroup>
                </CollapsibleContent>
              </Collapsible>
            )}
          </FieldSet>
        ))}
        {error && (
          <FieldDescription className="text-danger-600" role="alert">
            {error}
          </FieldDescription>
        )}
        <div className="flex gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex-1">
                <Button type="submit" size="sm" className="w-full" disabled={!canEdit || !dirty}>
                  Save changes
                </Button>
              </span>
            </TooltipTrigger>
            {(!canEdit || !dirty) && <TooltipContent>{canEdit ? 'Nothing changed yet' : editWhy}</TooltipContent>}
          </Tooltip>
          <Button type="button" size="sm" variant="outline" onClick={() => setError(props.onRotate(90))} disabled={!canEdit} aria-label="Rotate 90 degrees" title={editWhy}>
            <RotateCw data-icon="inline-start" />
            90°
          </Button>
        </div>
      </form>
      {props.airSide}
      <Separator />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Type values</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSharedBy(props.partsOfType())
            setTypeOpen(true)
          }}
          disabled={!canEditType}
          title={!canEdit ? editWhy : !type || type.typeParams.length === 0 ? 'This type has no type values to change' : undefined}
        >
          <Pencil data-icon="inline-start" />
          Edit type
        </Button>
      </div>
      {type?.model && props.onEditDefinition && (
        <Button size="sm" variant="outline" onClick={props.onEditDefinition} data-testid="edit-part-definition">
          <PencilRuler data-icon="inline-start" />
          Edit definition
        </Button>
      )}
      {type && typeSections.length > 0 ? (
        <ItemGroup className="gap-1" aria-label="Type values">
          {typeSections.flatMap((s) =>
            s.parameters.map((p) => {
              const v = storedValue(type, part, p)
              return (
                <Item key={p.name} size="xs" data-testid={`inspector-type-${p.name}`} data-section={s.id}>
                  <ItemContent>
                    <ItemDescription className="text-xs">
                      {s.label} · {p.label}
                    </ItemDescription>
                    <ItemTitle className="text-xs font-normal">{v === undefined ? '—' : formatValue(p.def, v)}</ItemTitle>
                  </ItemContent>
                </Item>
              )
            }),
          )}
        </ItemGroup>
      ) : (
        <p className="text-xs text-muted-foreground">This type has no type values.</p>
      )}
      {props.children}
      {props.spatial && (
        <>
          <Separator />
          {props.spatial}
        </>
      )}
      <Separator />
      <Button variant="outline" size="sm" className="text-danger-600" onClick={props.onDelete} disabled={!canEdit} title={editWhy}>
        <Trash2 data-icon="inline-start" />
        Delete…
      </Button>
      {type && <EditTypeDialog key={props.typeId + JSON.stringify(type.typeValues)} open={typeOpen} onOpenChange={setTypeOpen} type={type} part={part} params={typeSections.flatMap((s) => s.parameters)} partsOfType={sharedBy} onType={props.onType} />}
    </div>
  )
}

function EditTypeDialog({
  open,
  onOpenChange,
  type,
  part,
  params,
  partsOfType,
  onType,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  type: PartTypeDefinition
  part: PartInstance
  params: readonly InspectorParameter[]
  partsOfType: number
  onType: (values: Record<string, ParamValue | null>) => string | null
}) {
  const baseline: Record<string, string> = Object.fromEntries(params.map((p) => [p.name, displayText(p, storedValue(type, part, p))]))
  const [texts, setTexts] = useState(baseline)
  const [error, setError] = useState<string | null>(null)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const plan = planParameterEdit(type, part, params, texts, 'type')
    if ('problem' in plan) {
      setError(plan.problem)
      return
    }
    if (Object.keys(plan.values).length === 0) {
      onOpenChange(false)
      return
    }
    const refused = onType(plan.values)
    setError(refused)
    if (!refused) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit type: {type.typeName}</DialogTitle>
            <DialogDescription>{partsOfType === 1 ? 'This changes the 1 part of this type.' : `This changes all ${partsOfType} parts of this type.`}</DialogDescription>
          </DialogHeader>
          <FieldGroup className="max-h-[50vh] gap-2 overflow-y-auto">
            {params.map((p) => (
              <ParameterInput key={p.name} p={p} id={`bm-type-${p.name}`} text={texts[p.name] ?? ''} onText={(t) => setTexts({ ...texts, [p.name]: t })} disabled={p.locked !== undefined} {...(p.locked ? { why: p.locked } : {})} />
            ))}
          </FieldGroup>
          {error && (
            <FieldDescription className="text-danger-600" role="alert">
              {error}
            </FieldDescription>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save type</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
