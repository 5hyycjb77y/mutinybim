'use client'

import { ELECTRICAL_LOAD_CLASSES, type ParamDef, type PartConnector } from '@permitzip/bim-kernel'
import { loadClassLabel, parseLoadClass } from '@permitzip/bim-pack-electrical'
import { Checkbox } from '../../ui/checkbox'
import { Field, FieldLabel } from '../../ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { DimField } from './DimField'

const FROM_CATEGORY = '__category__'

/**
 * A power connector's electrical fields: voltage, poles, design load, load
 * class, continuous and motor horsepower. These are what circuiting checks
 * (voltage and poles against the panel) and what the load totals count
 * (load, class, continuous at 125%, a motor through the code's tables).
 * Numbers or the part's own parameters, like every other connector field.
 */
export function ElectricalConnectorFields({ connector, params, disabled, onChange }: { connector: PartConnector; params: readonly ParamDef[]; disabled: boolean; onChange: (patch: Partial<PartConnector>) => void }) {
  const id = connector.id
  const loadClass = connector.loadClass ? parseLoadClass(connector.loadClass) : null
  return (
    <div className="grid grid-cols-2 gap-1" data-testid={`pe-c-${id}-electrical`}>
      <DimField id={`pe-c-${id}-voltage`} label="Voltage (V)" unit="deg" value={connector.voltage ?? 0} params={params} disabled={disabled} onChange={(dim) => onChange({ voltage: dim })} />
      <Field>
        <FieldLabel htmlFor={`pe-c-${id}-poles`}>Poles</FieldLabel>
        <Select value={String(connector.poles ?? 1)} onValueChange={(v) => onChange({ poles: Number(v) })} disabled={disabled}>
          <SelectTrigger id={`pe-c-${id}-poles`} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="1">1 pole (line to neutral)</SelectItem>
              <SelectItem value="2">2 poles (line to line)</SelectItem>
              <SelectItem value="3">3 poles (3-phase)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <DimField id={`pe-c-${id}-load`} label="Load (VA)" unit="deg" value={connector.flow ?? 0} params={params} disabled={disabled} onChange={(dim) => onChange({ flow: dim })} />
      <Field>
        <FieldLabel htmlFor={`pe-c-${id}-class`}>Load class</FieldLabel>
        <Select value={loadClass ?? FROM_CATEGORY} onValueChange={(v) => onChange({ loadClass: v === FROM_CATEGORY ? undefined : v })} disabled={disabled}>
          <SelectTrigger id={`pe-c-${id}-class`} size="sm" data-testid={`pe-c-${id}-class`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={FROM_CATEGORY}>From the part&apos;s category</SelectItem>
              {ELECTRICAL_LOAD_CLASSES.map((c) => (
                <SelectItem key={c} value={c}>
                  {loadClassLabel(c)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <DimField id={`pe-c-${id}-hp`} label="Motor (hp)" unit="deg" value={connector.motorHp ?? 0} params={params} disabled={disabled} onChange={(dim) => onChange({ motorHp: dim === 0 ? undefined : dim })} />
      <Field orientation="horizontal" className="items-center self-end pb-1">
        <Checkbox id={`pe-c-${id}-continuous`} checked={connector.continuous ?? loadClass === 'lighting'} disabled={disabled} onCheckedChange={(v) => onChange({ continuous: v === true })} aria-label="Runs 3 hours or more (continuous, sized at 125%)" />
        <FieldLabel htmlFor={`pe-c-${id}-continuous`} className="text-xs font-normal">
          Continuous (3 h or more)
        </FieldLabel>
      </Field>
    </div>
  )
}
