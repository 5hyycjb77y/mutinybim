import { equipmentListDefinition } from '@permitzip/bim-library'
import { elementsOfKind, fieldProviderRegistry, takeoffScheduleDefinition, TAKEOFF_SCHEDULE_DESCRIPTION, TAKEOFF_SCHEDULE_NAME, type Command, type ModelState, type Registry, type ScheduleColumnDef, type ScheduleDefinitionV2 } from '@permitzip/bim-kernel'
import { validateScheduleDefinition } from '@permitzip/bim-kernel/schedules'

/**
 * Built-in list schedules for "list first, draw second" (NEXT-BATCH §1, F4):
 * the Equipment list, Not placed yet, and Loads. Each is an ordinary v2
 * schedule: it opens in the schedule grid, edits go back to the model, and it
 * can go on a sheet. Made from New schedule… or from the Equipment list.
 */

export type BuiltinListId = 'equipment_list' | 'not_placed_yet' | 'loads' | 'space_loads' | 'panel_loads' | 'takeoff'

export const BUILTIN_LIST_IDS: readonly BuiltinListId[] = ['equipment_list', 'not_placed_yet', 'loads', 'space_loads', 'panel_loads', 'takeoff']

/** The one-click load schedules (Views › Schedules › Load schedules, and New schedule…). */
export const LOAD_SCHEDULE_IDS: readonly BuiltinListId[] = ['space_loads', 'panel_loads', 'loads']

export const BUILTIN_LIST_LABELS: Readonly<Record<BuiltinListId, string>> = {
  equipment_list: 'Equipment list',
  not_placed_yet: 'Not placed yet',
  loads: 'Loads',
  space_loads: 'Space loads',
  panel_loads: 'Panel loads',
  takeoff: TAKEOFF_SCHEDULE_NAME,
}

export const BUILTIN_LIST_DESCRIPTIONS: Readonly<Record<BuiltinListId, string>> = {
  equipment_list: 'Every piece of equipment and fixture, planned and placed, with its electrical, gas and water values',
  not_placed_yet: 'Everything that exists but nobody has drawn yet: panels, rooftop units, kitchen items',
  loads: 'Every load row, fixture or point, typed or drawn: whether it is piped yet, and what it counts (fixture units, gas, power, air) with a totals row',
  space_loads: 'Every space with its estimate, the devices placed in it so far, and what it counts, per trade (power, water, drainage, gas, air); columns with nothing in them stay hidden',
  panel_loads: 'Every panel with the estimates and devices that name it as their source, and what it counts',
  takeoff: TAKEOFF_SCHEDULE_DESCRIPTION,
}

const PART_CLASSES = ['mep.mechanical_equipment', 'mep.air_terminal', 'mep.duct_accessory', 'mep.pipe_accessory', 'mep.plumbing_fixture', 'mep.electrical_equipment', 'mep.electrical_device', 'mep.lighting_fixture', 'gen.generic_model']

const field = (id: string, heading?: string): ScheduleColumnDef => ({ id, kind: 'field', path: id, ...(heading ? { heading } : {}) })
const param = (id: string, heading: string): ScheduleColumnDef => ({ id, kind: 'parameter', path: id, heading, hideWhenEmpty: true })

const base = (name: string): Pick<ScheduleDefinitionV2, 'name' | 'groups' | 'grandTotals' | 'itemize' | 'presentation' | 'display' | 'filters'> => ({
  name,
  filters: [],
  groups: [],
  grandTotals: false,
  itemize: true,
  presentation: { kind: 'list' },
  display: { textSizeMm: 2.5, emptyText: 'NONE' },
})

/**
 * The Equipment list: the built-in schedule template (round 5b,
 * `@permitzip/bim-library` `equipmentListDefinition`). Its columns are
 * parameters in one group per facet; today's thirteen columns lead with the
 * same ids and headings, and the baseline parameter columns stay hidden until
 * a row has a value. Lists already in a model keep the definition they store.
 */
export const EQUIPMENT_LIST_SCHEDULE: ScheduleDefinitionV2 = equipmentListDefinition()

export const NOT_PLACED_YET_SCHEDULE: ScheduleDefinitionV2 = {
  ...base('Not placed yet'),
  source: { kind: 'classes', classes: PART_CLASSES, includeSubclasses: true },
  filters: [{ path: 'placement', op: 'equals', value: 'Not placed yet' }],
  columns: [field('mark', 'MARK'), field('family', 'WHAT'), field('type', 'TYPE'), param('description', 'DESCRIPTION'), field('planned_level', 'PLANNED LEVEL')],
  sort: [{ path: 'mark', direction: 'asc' }],
}

/** A quantity column of what each load counts (the loads provider, typed units); the totals row is the project total. */
const counted = (path: string, heading: string): ScheduleColumnDef => ({ id: path, kind: 'field', path, heading, hideWhenEmpty: true, total: true })

/**
 * Every load row, fixture or point, typed or drawn: where it is in its life
 * (Status says whether it is piped yet) and what it counts, per quantity,
 * with a totals row. On 7329: 25.75 / 13.5 / 30.25 WSFU, 79 DFU, 140 gal/h,
 * 859 CFH. Estimate / Devices so far columns are in Fields.
 */
export const LOADS_SCHEDULE: ScheduleDefinitionV2 = {
  ...base('Loads'),
  grandTotals: true,
  source: { kind: 'classes', classes: ['mep.load_point'], includeSubclasses: true },
  columns: [
    field('mark', 'MARK'),
    { ...field('connection_type.mark', 'CONNECTION TYPE'), hideWhenEmpty: true },
    field('load.stage', 'STAGE'),
    field('load.status', 'STATUS'),
    counted('loads.counted.wsfu_cold', 'CW WSFU'),
    counted('loads.counted.wsfu_hot', 'HW WSFU'),
    counted('loads.counted.wsfu_total', 'TOTAL WSFU'),
    counted('loads.counted.dfu', 'DFU'),
    counted('loads.counted.gph_demand', 'HW DEMAND'),
    counted('loads.counted.mbh', 'GAS INPUT'),
    counted('loads.counted_gas_flow', 'GAS FLOW'),
    counted('loads.counted.va', 'ELEC LOAD'),
    counted('loads.counted.cfm', 'AIRFLOW'),
  ],
  sort: [{ path: 'mark', direction: 'asc' }],
}

/** Estimate, devices so far and counted for one quantity: the loads provider's three sides, hidden when empty, totalled. */
const sides = (q: string, unitHeading: string): ScheduleColumnDef[] => [
  { id: `loads.allocated.${q}`, kind: 'field', path: `loads.allocated.${q}`, heading: `ESTIMATE ${unitHeading}`, hideWhenEmpty: true, total: true },
  { id: `loads.actual.${q}`, kind: 'field', path: `loads.actual.${q}`, heading: `DEVICES SO FAR ${unitHeading}`, hideWhenEmpty: true, total: true },
  { id: `loads.counted.${q}`, kind: 'field', path: `loads.counted.${q}`, heading: `COUNTED ${unitHeading}`, hideWhenEmpty: true, total: true },
]

const ESTIMATE_VS_DEVICES: ScheduleColumnDef = { id: 'loads.estimate_vs_devices', kind: 'field', path: 'loads.estimate_vs_devices', heading: 'ESTIMATE VS DEVICES', hideWhenEmpty: true }

/**
 * Space loads: each space's estimate beside the devices placed in it so far
 * and what it counts (product decision, Oct 27, decision 4), for every trade at once.
 * A trade with nothing in the model hides its columns, so one list reads as
 * the electrical, plumbing, gas or air load study.
 */
export const SPACE_LOADS_SCHEDULE: ScheduleDefinitionV2 = {
  ...base('Space loads'),
  grandTotals: true,
  source: { kind: 'classes', classes: ['gen.space'], includeSubclasses: true },
  columns: [
    field('number', 'NUMBER'),
    field('name', 'NAME'),
    { ...field('area', 'AREA'), hideWhenEmpty: true },
    ...sides('va', '(VA)'),
    ...sides('wsfu_total', '(WSFU)'),
    ...sides('dfu', '(DFU)'),
    ...sides('mbh', '(MBH)'),
    ...sides('cfm', '(CFM)'),
    ESTIMATE_VS_DEVICES,
  ],
  sort: [{ path: 'number', direction: 'asc' }],
}

/** Panel loads: what names each panel as its source, estimates and devices, and what it counts. */
export const PANEL_LOADS_SCHEDULE: ScheduleDefinitionV2 = {
  ...base('Panel loads'),
  grandTotals: true,
  source: { kind: 'classes', classes: ['mep.electrical_equipment'], includeSubclasses: true },
  columns: [field('mark', 'MARK'), field('type', 'TYPE'), ...sides('va', '(VA)'), ESTIMATE_VS_DEVICES],
  sort: [{ path: 'mark', direction: 'asc' }],
}

/**
 * The registry a native v2 list that names trade provider fields (Loads, Not
 * placed yet) opens over: the kernel's, with every field provider. The model
 * server's grid and sheet printing use it when the built-in registry refuses
 * such a list (`kernelScheduleEvaluator`, `scheduleV2Paper`), so a list that
 * passes here opens and prints.
 */
export function builtinListRegistry(): Registry {
  return fieldProviderRegistry()
}

export const BUILTIN_LISTS: Readonly<Record<BuiltinListId, ScheduleDefinitionV2>> = {
  equipment_list: EQUIPMENT_LIST_SCHEDULE,
  not_placed_yet: NOT_PLACED_YET_SCHEDULE,
  loads: LOADS_SCHEDULE,
  space_loads: SPACE_LOADS_SCHEDULE,
  panel_loads: PANEL_LOADS_SCHEDULE,
  takeoff: takeoffScheduleDefinition(),
}

/**
 * Why a built-in list can't be made in this model yet, in words, or null.
 * The definition is checked against the model's fields, so a list whose
 * fields haven't shipped says so instead of opening an empty grid.
 */
function problemsOf(model: ModelState, def: ScheduleDefinitionV2, id: BuiltinListId, registry?: Registry): readonly { readonly message: string }[] {
  return validateScheduleDefinition(model, def, { viewId: `builtin-${id}`, revision: model.revision, ...(registry ? { registry } : {}) })
}

/**
 * The list as this model can open it. The Equipment list's Placement column
 * needs the placement field (planned parts); a model whose registry doesn't
 * have it yet gets the list without that one column rather than no list.
 */
export function builtinListDefinition(model: ModelState, id: BuiltinListId): ScheduleDefinitionV2 {
  const def = BUILTIN_LISTS[id]
  if (id !== 'equipment_list' || problemsOf(model, def, id).length === 0) return def
  return { ...def, columns: def.columns.filter((c) => c.id !== 'placement') }
}

export function builtinListBlocked(model: ModelState | null, id: BuiltinListId): string | null {
  if (!model) return 'The model is still loading.'
  let problems: readonly { readonly message: string }[]
  try {
    // As the model server opens it: the built-in registry, else every field provider.
    const def = builtinListDefinition(model, id)
    const builtin = problemsOf(model, def, id)
    problems = builtin.length === 0 ? builtin : problemsOf(model, def, id, builtinListRegistry())
  } catch (err) {
    console.error('[builtin-lists] checking a built-in list failed', { id, err })
    return `${BUILTIN_LIST_LABELS[id]} can't be checked: ${err instanceof Error ? err.message : String(err)}`
  }
  const first = problems[0]
  if (!first) return null
  return `${BUILTIN_LIST_LABELS[id]} can't be made yet: ${first.message}`
}

export function builtinListCommand(model: ModelState, viewId: string, name: string, id: BuiltinListId): Command {
  return { type: 'create_view', viewId, name: name.trim(), viewType: 'schedule', props: { scheduleV2: { ...builtinListDefinition(model, id), name: name.trim() } } }
}

/** The model's schedule view made from a built-in list, by its name, so the Equipment list opens the same one each time. */
export function findBuiltinListView(model: Pick<ModelState, 'elements'> | null, id: BuiltinListId): string | null {
  if (!model) return null
  const want = BUILTIN_LIST_LABELS[id].toLowerCase()
  for (const el of elementsOfKind(model.elements, 'view')) {
    if (!el.deleted && el.viewType === 'schedule' && el.props?.scheduleV2 && el.name.toLowerCase() === want) return el.id
  }
  return null
}
