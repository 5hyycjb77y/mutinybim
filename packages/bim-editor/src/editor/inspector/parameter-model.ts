import { BASELINE_KIND_FACETS, EQUIPMENT_DEFAULT_COLUMNS } from '@permitzip/bim-library'
import { BUILTIN_FACET_REGISTRY, groupParametersByFacet, partParameters, type FacetRegistry, type ParamDef, type ParameterDef, type ParamValue, type PartInstance, type PartTypeDefinition } from '@permitzip/bim-kernel'
import { convert, displayUnit, type DisplayProfile, type Kind, type UnitCode } from '@permitzip/bim-units'
import { parseParameterText, type EquipmentParameter, type ParameterSource } from '../equipment-list/parameters'

/**
 * The Inspector's model (NEXT-BATCH 5b-2): one list of parameters for a
 * part, from its type's parameters (`partParameters`, the same
 * `ParameterDef`s the schedule engine reads) and the library's fields that
 * apply to it (baseline, firm, project), in one section per facet of the
 * facet registry (data; the built-in one unless the host passes its own). Values are
 * stored as the part type stores them; each is shown in a display unit (the
 * unit profile's for its kind when there is one, else the stored unit; lengths
 * in feet as the part editors always showed them). Pure: the component renders
 * this and sends what `planParameterEdit` returns.
 */

export interface InspectorParameter {
  /** The part parameter name. */
  readonly name: string
  readonly key: string
  readonly label: string
  readonly group?: string
  readonly scope: 'instance' | 'type'
  readonly valueType: 'quantity' | 'text' | 'boolean' | 'choice'
  readonly kind?: Kind
  /** The unit the part stores the number in. */
  readonly storedUnit?: UnitCode
  /** The unit it is shown and typed in. */
  readonly displayUnit?: UnitCode
  readonly choices?: readonly string[]
  /** The part's own definition when its type declares it; absent: a library field not on the type yet. */
  readonly def?: ParamDef
  /** The library field it comes from, when it does. */
  readonly library?: EquipmentParameter
  readonly source: 'part' | ParameterSource
  /** Why it can't be typed in (a formula, read from elsewhere); absent: editable. */
  readonly locked?: string
}

export interface InspectorSection {
  readonly id: string
  /** The facet row's id; null for a firm's own group or ungrouped. */
  readonly facet: string | null
  readonly label: string
  readonly parameters: readonly InspectorParameter[]
}

/**
 * The facet ids the equipment list's own columns name (template data), so a
 * listed item's "CW" is water and "Waste" drainage even with no unit to go by.
 * Ungrouped columns (connection) are left out.
 */
const DEFAULT_FACETS: ReadonlyMap<string, string> = new Map(EQUIPMENT_DEFAULT_COLUMNS.filter((c) => !c.facet.startsWith('other:')).map((c) => [c.column.id, c.facet]))

/** A part's own parameter's group: the library field's, else the template's column group, else the baseline data's kind guess, else none. */
function partGroup(name: string, kind: string | undefined, library: EquipmentParameter | undefined): string | undefined {
  return library?.group ?? DEFAULT_FACETS.get(name) ?? (kind === undefined ? undefined : BASELINE_KIND_FACETS[kind])
}

function displayOf(kind: Kind | undefined, stored: UnitCode | undefined, preferred: UnitCode | undefined, profile: DisplayProfile | undefined): UnitCode | undefined {
  if (stored === undefined) return undefined
  if (kind === 'length' && !profile) return 'ft'
  if (profile && kind) {
    try {
      return displayUnit(kind, profile)
    } catch (err) {
      console.error('[inspector] no display unit for this kind in the profile; showing the stored unit', { kind, profile: profile.id, err })
    }
  }
  return preferred ?? stored
}

function fromPart(p: ParameterDef, def: ParamDef, library: EquipmentParameter | undefined, profile: DisplayProfile | undefined): InspectorParameter {
  const name = def.name
  const scope = p.binding === 'type' ? 'type' : 'instance'
  const kind = p.kind
  const facetGroup = partGroup(name, kind, library)
  const storedUnit = p.storedUnit
  return {
    name,
    key: p.key,
    label: def.label || name,
    ...(facetGroup === undefined ? {} : { group: facetGroup }),
    scope,
    valueType: p.valueType === 'quantity' ? 'quantity' : p.valueType === 'boolean' ? 'boolean' : p.valueType === 'choice' ? 'choice' : 'text',
    ...(kind === undefined ? {} : { kind }),
    ...(storedUnit === undefined ? {} : { storedUnit }),
    ...(storedUnit === undefined ? {} : { displayUnit: displayOf(kind, storedUnit, library?.unit, profile) }),
    ...(p.choices === undefined ? {} : { choices: p.choices }),
    def,
    ...(library ? { library } : {}),
    source: 'part',
    ...(p.writer.kind === 'none' ? { locked: p.writer.reason } : {}),
  }
}

function fromLibrary(lib: EquipmentParameter, profile: DisplayProfile | undefined): InspectorParameter {
  const kind = lib.kind
  const unit = lib.unit
  return {
    name: lib.name,
    key: lib.key,
    label: lib.label,
    ...(lib.group === undefined ? {} : { group: lib.group }),
    scope: 'instance',
    valueType: lib.valueType,
    ...(kind === undefined ? {} : { kind }),
    ...(unit === undefined ? {} : { storedUnit: unit, displayUnit: displayOf(kind, unit, unit, profile) }),
    ...(lib.choices === undefined ? {} : { choices: lib.choices }),
    library: lib,
    source: lib.source,
  }
}

/**
 * Every parameter of a part, in facet sections: its type's parameters (type
 * values and instance values alike), then the library fields that apply to
 * equipment and fixtures and that the type doesn't declare yet. `connection_type`
 * and anything `hidden` reads elsewhere is left to its own control.
 */
export function inspectorSections(type: PartTypeDefinition, library: readonly EquipmentParameter[], options: { readonly profile?: DisplayProfile; readonly hidden?: ReadonlySet<string>; readonly includeLibrary?: boolean; readonly facets?: FacetRegistry } = {}): InspectorSection[] {
  const hidden = options.hidden ?? new Set<string>()
  const libraryByName = new Map(library.map((l) => [l.name, l]))
  const own = new Map<string, ParamDef>([...type.typeParams, ...type.instanceParams].map((d) => [d.name, d]))
  const items: InspectorParameter[] = []
  for (const p of partParameters(type)) {
    const name = p.writer.kind === 'parameter' ? p.writer.name : p.path.replace(/^param\./, '')
    const def = own.get(name)
    if (!def || hidden.has(name)) continue
    items.push(fromPart(p, def, libraryByName.get(name), options.profile))
  }
  if (options.includeLibrary !== false && (type.category === 'mechanical_equipment' || type.category === 'plumbing_fixture')) {
    for (const lib of library) if (!own.has(lib.name) && !hidden.has(lib.name)) items.push(fromLibrary(lib, options.profile))
  }
  return groupParametersByFacet(items, options.facets ?? BUILTIN_FACET_REGISTRY).map((g) => ({ id: g.id, facet: g.facet, label: g.label, parameters: g.items }))
}

/** The value a part holds for a parameter: its own, else its type's, else the default. */
export function storedValue(type: PartTypeDefinition, part: PartInstance, p: InspectorParameter): ParamValue | undefined {
  if (p.scope === 'type') return type.typeValues[p.name] ?? p.def?.default
  return part.values[p.name] ?? type.typeValues[p.name] ?? p.def?.default
}

const round = (n: number): number => Math.round(n * 1000) / 1000

/** What the field shows for a stored value, in the display unit. */
export function displayText(p: InspectorParameter, value: ParamValue | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'number' && p.valueType === 'quantity' && p.storedUnit && p.displayUnit && p.storedUnit !== p.displayUnit) {
    try {
      return String(round(convert(value, p.storedUnit, p.displayUnit)))
    } catch (err) {
      console.error('[inspector] converting for display failed; showing the stored number', { name: p.name, from: p.storedUnit, to: p.displayUnit, err })
      return String(value)
    }
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/** A typed text back to the stored value: null clears, `problem` says why it can't be read. */
export function parseDisplayText(p: InspectorParameter, text: string): { readonly value: ParamValue | null } | { readonly problem: string } {
  const t = text.trim()
  if (t === '') return { value: null }
  if (p.valueType === 'quantity') {
    const n = Number(t.replace(/,/g, ''))
    if (!Number.isFinite(n)) return { problem: `${p.label} must be a number${p.displayUnit && p.displayUnit !== '1' ? ` in ${p.displayUnit}` : ''}.` }
    if (p.storedUnit && p.displayUnit && p.storedUnit !== p.displayUnit) return { value: convert(n, p.displayUnit, p.storedUnit) }
    return { value: n }
  }
  if (p.valueType === 'boolean') return { value: t === 'true' }
  if (p.library && !p.def) {
    const read = parseParameterText(p.library, t)
    return 'problem' in read ? read : { value: read.value }
  }
  return { value: t }
}

/**
 * What a Save sends for the parameters of one scope: the changed values, and
 * the library fields the type must declare first. Unchanged texts send nothing.
 */
export function planParameterEdit(type: PartTypeDefinition, part: PartInstance, params: readonly InspectorParameter[], texts: Readonly<Record<string, string>>, scope: 'instance' | 'type'): { readonly values: Record<string, ParamValue | null>; readonly declare: readonly EquipmentParameter[] } | { readonly problem: string } {
  const values: Record<string, ParamValue | null> = {}
  const declare: EquipmentParameter[] = []
  for (const p of params) {
    if (p.scope !== scope || p.locked) continue
    const text = texts[p.name]
    if (text === undefined || text === displayText(p, storedValue(type, part, p))) continue
    const read = parseDisplayText(p, text)
    if ('problem' in read) return read
    if (!p.def) {
      if (read.value === null) continue
      if (p.library) declare.push(p.library)
    }
    values[p.name] = read.value
  }
  return { values, declare }
}
