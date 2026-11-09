import { baselineParameterFields, EQUIPMENT_LIST_CLASSES, type SharedFieldItem } from '@permitzip/bim-library'
import { PARAM_UNIT_BINDINGS, LEGACY_PARAM_UNITS } from '@permitzip/bim-units'
import { numberIn } from '@permitzip/bim-units'
import type { Command, ModelState, ParamDef, ParamValue, PartTypeDefinition } from '@permitzip/bim-kernel'

/**
 * A parameter the equipment list, the paste dialog and the Inspector can
 * show and fill: a library shared field (built-in baseline, the firm's, or
 * this project's) stored as a part parameter. Its value is kept on the part
 * under `name`, in the field's own unit, exactly as a part parameter of that
 * unit is (KERNEL-FOUNDATION §3.2: the library field and the part parameter
 * are one parameter).
 */
export type ParameterSource = 'builtin' | 'firm' | 'project'

export interface EquipmentParameter {
  /** The part parameter name (the field's storage name): `hood_id`. */
  readonly name: string
  /** The library key: `param.hood_id`. */
  readonly key: string
  readonly label: string
  readonly group?: string
  readonly valueType: SharedFieldItem['valueType']
  readonly kind?: SharedFieldItem['kind']
  readonly unit?: SharedFieldItem['unit']
  readonly choices?: readonly string[]
  readonly scope: 'instance' | 'type'
  readonly source: ParameterSource
  readonly appliesTo: readonly string[]
}

const EQUIPMENT_CLASS_SET: ReadonlySet<string> = new Set(['mep.equipment', ...EQUIPMENT_LIST_CLASSES])

/** A shared field as an equipment parameter, or null when it isn't kept on the part or doesn't apply to equipment and fixtures. */
export function equipmentParameterOf(item: SharedFieldItem, source: ParameterSource): EquipmentParameter | null {
  if (item.storage.kind !== 'parameter' || !item.editable) return null
  if (!item.appliesTo.some((c) => EQUIPMENT_CLASS_SET.has(c))) return null
  return {
    name: item.storage.name,
    key: item.key,
    label: item.label,
    ...(item.group === undefined ? {} : { group: item.group }),
    valueType: item.valueType,
    ...(item.kind === undefined ? {} : { kind: item.kind }),
    ...(item.unit === undefined ? {} : { unit: item.unit }),
    ...(item.choices === undefined ? {} : { choices: item.choices }),
    scope: item.storage.scope,
    source,
    appliesTo: item.appliesTo,
  }
}

/** The baseline parameters every model offers (MCA, MOCP, manufacturer, airflow, weight…). */
export function builtinEquipmentParameters(): EquipmentParameter[] {
  return baselineParameterFields().flatMap((f) => {
    const p = equipmentParameterOf(f, 'builtin')
    return p ? [p] : []
  })
}

/** Layered: a project field hides a firm field of the same name, a firm field a built-in one (the library's own precedence). */
export function layerParameters(lists: readonly (readonly EquipmentParameter[])[]): EquipmentParameter[] {
  const byName = new Map<string, EquipmentParameter>()
  const rank: Readonly<Record<ParameterSource, number>> = { project: 0, firm: 1, builtin: 2 }
  for (const list of lists) {
    for (const p of list) {
      const seen = byName.get(p.name)
      if (!seen || rank[p.source] < rank[seen.source]) byName.set(p.name, p)
    }
  }
  return [...byName.values()]
}

/** The legacy part-parameter unit a library unit is stored as, so a declared parameter stores the number as typed. */
function legacyUnitOf(p: EquipmentParameter): ParamDef['unit'] | null {
  if (p.unit === undefined) return null
  for (const u of LEGACY_PARAM_UNITS) {
    const b = PARAM_UNIT_BINDINGS[u]
    if (b.unit === p.unit && (p.kind === undefined || b.kind === p.kind)) return u
  }
  return null
}

/** The part parameter that keeps this field, or why it can't be kept on a part yet. */
export function paramDefOf(p: EquipmentParameter): { readonly def: ParamDef } | { readonly refused: string } {
  switch (p.valueType) {
    case 'text':
      return { def: { name: p.name, label: p.label, kind: 'text' } }
    case 'boolean':
      return { def: { name: p.name, label: p.label, kind: 'boolean' } }
    case 'choice':
      return p.choices && p.choices.length > 0 ? { def: { name: p.name, label: p.label, kind: 'choice', choices: [...p.choices] } } : { def: { name: p.name, label: p.label, kind: 'text' } }
    case 'quantity': {
      if (p.kind === 'length' && p.unit === 'mm') return { def: { name: p.name, label: p.label, kind: 'length' } }
      const unit = legacyUnitOf(p)
      if (unit === null) return { refused: `${p.label} is in ${p.unit ?? 'no unit'}, which a part can't store yet; ask a library editor to use one of the part units (V, A, VA, kW, hp, Btu/h, tons, CFM, GPM, psi, in. w.c., lb, %).` }
      return { def: { name: p.name, label: p.label, kind: 'number', unit, min: 0 } }
    }
  }
}

/**
 * The parameters a part type doesn't declare yet, as part parameters, or the
 * first one that can't be. They are declared on each part (instance), even a
 * field the library keeps on the type: the value someone types belongs to the
 * part they typed it on, and one part type often holds unrelated items (every
 * pasted kitchen item is a "Listed item"). A parameter the type already
 * declares keeps its own scope.
 */
export function undeclared(def: PartTypeDefinition, params: readonly EquipmentParameter[]): { readonly instance: ParamDef[]; readonly type: ParamDef[] } | { readonly refused: string } {
  const have = new Set([...def.instanceParams, ...def.typeParams].map((p) => p.name))
  const instance: ParamDef[] = []
  for (const p of params) {
    if (have.has(p.name)) continue
    have.add(p.name)
    const d = paramDefOf(p)
    if ('refused' in d) return d
    instance.push(d.def)
  }
  return { instance, type: [] }
}

/**
 * The `save_part_types` that declares `params` on a part type held in the
 * model, or null when it already declares all of them. The type's values,
 * geometry and every part of the type stay as they are: the new parameters
 * start empty.
 */
export type SavePartTypes = Extract<Command, { type: 'save_part_types' }>

export function declareParameters(model: Pick<ModelState, 'elements'>, typeId: string, params: readonly EquipmentParameter[]): { readonly command: SavePartTypes | null } | { readonly refused: string } {
  const type = model.elements[typeId]
  if (type?.kind !== 'part_type') return { refused: 'Its part type is missing from the model.' }
  return declareOnType(typeId, type.definition, params)
}

/** `declareParameters` for a type definition already in hand (the Inspector holds its part's). */
export function declareOnType(typeId: string, current: PartTypeDefinition, params: readonly EquipmentParameter[]): { readonly command: SavePartTypes | null } | { readonly refused: string } {
  const missing = undeclared(current, params)
  if ('refused' in missing) return missing
  if (missing.instance.length === 0 && missing.type.length === 0) return { command: null }
  const definition: PartTypeDefinition = { ...current, instanceParams: [...current.instanceParams, ...missing.instance], typeParams: [...current.typeParams, ...missing.type] }
  const names = [...missing.instance, ...missing.type].map((p) => p.label).join(', ')
  return { command: { type: 'save_part_types', label: `Add ${names} to ${current.typeName}`, types: [{ typeId, definition }] } }
}

const YES = /^(y|yes|true|x|✓)$/i
const NO = /^(n|no|false|-|—)$/i

/** A typed value for a parameter; null clears it; a string says why it can't be read. */
export function parseParameterText(p: EquipmentParameter, raw: string): { readonly value: ParamValue | null } | { readonly problem: string } {
  const t = raw.trim()
  if (t === '') return { value: null }
  if (p.valueType === 'quantity') {
    const n = numberIn(t)
    if (n === null || !Number.isFinite(n)) return { problem: `${p.label} "${raw}" isn't a number${p.unit ? ` in ${p.unit}` : ''}.` }
    if (n < 0) return { problem: `${p.label} can't be below zero.` }
    return { value: n }
  }
  if (p.valueType === 'boolean') {
    if (YES.test(t)) return { value: true }
    if (NO.test(t)) return { value: false }
    return { problem: `${p.label} "${raw}" is yes or no.` }
  }
  if (p.valueType === 'choice' && p.choices && p.choices.length > 0) {
    const hit = p.choices.find((c) => c.toLowerCase() === t.toLowerCase())
    if (!hit) return { problem: `${p.label} is one of ${p.choices.join(', ')}.` }
    return { value: hit }
  }
  return { value: t.slice(0, 200) }
}
