import { necEdition, type NecEdition } from '@permitzip/bim-calc'
import { loadFromText, numberIn, proposeEquipmentLoads, readEquipmentSchedule, suggestLoadClass, type EquipmentScheduleRow, type LoadClass, type ProposedEquipmentLoad } from '@permitzip/bim-pack-electrical'
import { CONNECTION_TYPE_PARAM, elementsOfKind, type Command, type ModelState, type ParamDef, type ParamValue, type PartCategory, type PartTypeDefinition } from '@permitzip/bim-kernel'
import { EQUIPMENT_DRAFT_FIELDS, EQUIPMENT_DRAFT_PARAMETERS } from '@permitzip/bim-library'
import { declareParameters, parseParameterText, undeclared, type EquipmentParameter } from './parameters'

/**
 * The Equipment list (ROADMAP F4, NEXT-BATCH §5 step 1): rows pasted from a
 * kitchen vendor's or mechanical schedule become planned equipment, parts
 * that exist (with their electrical, gas and water values) before anyone
 * draws them. They show in Not placed yet, schedules, circuits and the
 * one-line; placing one later keeps its id and everything that points at it.
 *
 * Every row becomes one `plan_part` per unit, all in one `batch_edits`, so the
 * whole list is one undo step and either all of it lands or none of it does.
 */

/** One row of the preview grid, as the engineer corrects it. Text throughout: it is what they typed. */
export interface EquipmentDraftRow {
  /** Stable while editing (the pasted line, or a new row's counter). */
  readonly key: string
  readonly mark: string
  readonly description: string
  readonly quantity: string
  readonly voltage: string
  readonly phase: string
  /** "17 kW", "4.2 A", "1,320 W", "2 hp". */
  readonly load: string
  readonly gasMbh: string
  readonly coldWater: string
  readonly hotWater: string
  readonly waste: string
  readonly connection: string
  /**
   * Columns beyond the eleven, by the parameter each fills (`mca`, `hood_id`):
   * the text as written. Absent on drafts from before round 5b, which paste
   * and fill exactly the eleven as they always did.
   */
  readonly extras?: Readonly<Record<string, string>>
}

export type DraftField = Exclude<keyof EquipmentDraftRow, 'key' | 'extras'>

/** The eleven pasted columns: the equipment list template's default mapping (`EQUIPMENT_DRAFT_PARAMETERS`). */
export const DRAFT_FIELDS: readonly DraftField[] = EQUIPMENT_DRAFT_FIELDS

/** Column headings in the preview grid, the words on a vendor's schedule. */
export const DRAFT_FIELD_LABELS: Readonly<Record<DraftField, string>> = {
  mark: EQUIPMENT_DRAFT_PARAMETERS.mark.label,
  description: EQUIPMENT_DRAFT_PARAMETERS.description.label,
  quantity: EQUIPMENT_DRAFT_PARAMETERS.quantity.label,
  voltage: EQUIPMENT_DRAFT_PARAMETERS.voltage.label,
  phase: EQUIPMENT_DRAFT_PARAMETERS.phase.label,
  load: EQUIPMENT_DRAFT_PARAMETERS.load.label,
  gasMbh: EQUIPMENT_DRAFT_PARAMETERS.gasMbh.label,
  coldWater: EQUIPMENT_DRAFT_PARAMETERS.coldWater.label,
  hotWater: EQUIPMENT_DRAFT_PARAMETERS.hotWater.label,
  waste: EQUIPMENT_DRAFT_PARAMETERS.waste.label,
  connection: EQUIPMENT_DRAFT_PARAMETERS.connection.label,
}

// ---------------------------------------------------------------- columns beyond the eleven

/** A pasted heading the eleven don't read, and the parameter it fills (null: not used). */
export interface PastedColumn {
  /** Cell position in the header row; negative for a column added by hand (Add column). */
  readonly index: number
  readonly heading: string
  readonly parameter: string | null
  /**
   * The eleven read it too (an MCA column is also read as amps when the sheet
   * gives no kW). False: the eleven folded it into the description, so a
   * mapped column's text comes out of the description.
   */
  readonly alsoRead: boolean
}

/** bim-calc's schedule header words (`equipment-list.ts`, SCHEDULE_HEADER_WORDS): what the eleven read. Anything else it folds into the description. */
const READ_HEADINGS: readonly RegExp[] = [
  /^(tag|item|mark|no\.?|#|item ?no\.?|symbol|designator|k-?tag)$/i,
  /^(description|equipment|name|item description|desc\.?|equipment description)$/i,
  /^(qty|quantity|count|no\. ?req'?d)$/i,
  /^(volts?|voltage|v)$/i,
  /^(ph|phase|phases|Ø|φ)$/i,
  /^(kva)$/i,
  /^(va|load ?\(va\)|load)$/i,
  /^(kw|load ?\(kw\))$/i,
  /^(w|watts?|load ?\(w\))$/i,
  /^(a|amps?|fla|mca|current)$/i,
  /^(hp|horsepower)$/i,
  /^(mbh|gas|gas ?mbh|gas ?\(mbh\)|gas input|input ?\(mbh\)|mbtuh|kbtuh)$/i,
  /^(btu|btuh|btu\/h|btu\/hr|gas ?\(btuh?\))$/i,
  /^(cw|dcw|cold|cold water|cw ?conn\.?)$/i,
  /^(hw|dhw|hot|hot water|hw ?conn\.?)$/i,
  /^(waste|drain|ind\.? ?waste|iw|dw|san\.?|sanitary)$/i,
  /^(dfu)$/i,
  /^(wsfu|fu)$/i,
  /^(conn\.?|connection|connection type|elec\.? ?conn\.?|type of connection|ct)$/i,
]

/** Headings the eleven read as a load input that are a parameter of their own as well. */
const ALSO_PARAMETERS: readonly RegExp[] = [/^mca$/i]

const normal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Initials of a label: "Minimum circuit ampacity" → "mca". */
const initials = (s: string): string => normal(s).split(' ').map((w) => w[0] ?? '').join('')

function guessParameter(heading: string, parameters: readonly EquipmentParameter[]): string | null {
  const h = normal(heading)
  if (h === '') return null
  const hit = parameters.find((p) => normal(p.label) === h || normal(p.name) === h || p.name === h.replace(/ /g, '_')) ?? parameters.find((p) => initials(p.label) === h.replace(/ /g, '') && h.length >= 2)
  return hit?.name ?? null
}

type Split = (line: string) => string[]

function csvCells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"'
        i++
      } else quoted = !quoted
    } else if (ch === ',' && !quoted) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

/**
 * Pasted lines as bim-calc counts them (non-blank), and how cells split, by
 * bim-calc's own rule: tabs anywhere (a spreadsheet), commas on every line
 * with no column gap (a CSV). PDF text (runs of spaces) has no extra columns
 * read: its empty cells can't be told apart.
 */
function pastedLines(text: string): { readonly lines: readonly string[]; readonly split: Split | null } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, ' ')).filter((l) => l.trim() !== '')
  if (lines.some((l) => l.includes('\t'))) return { lines, split: (l) => l.split('\t').map((c) => c.trim()) }
  if (lines.length > 0 && lines.every((l) => l.includes(',')) && !lines.some((l) => /\S\s{2,}\S/.test(l))) return { lines, split: csvCells }
  return { lines, split: null }
}

/**
 * The headings of a pasted schedule that the eleven columns don't read, each
 * with the parameter whose label, name or initials it matches ("MCA" →
 * Minimum circuit ampacity, "Hood ID" → the firm's Hood ID), or none.
 */
export function pastedColumns(nec: NecEdition | null, text: string, parameters: readonly EquipmentParameter[]): PastedColumn[] {
  if (!text.trim()) return []
  const headerLine = readEquipmentSchedule(nec ?? UNIT_READING_EDITION, text).headerLine
  const { lines, split } = pastedLines(text)
  if (headerLine === null || split === null) return []
  const header = split(lines[headerLine - 1] ?? '')
  const out: PastedColumn[] = []
  header.forEach((heading, index) => {
    const h = heading.replace(/[()]/g, '').trim()
    if (h === '') return
    const alsoRead = ALSO_PARAMETERS.some((re) => re.test(h))
    if (!alsoRead && READ_HEADINGS.some((re) => re.test(h))) return
    out.push({ index, heading: h, parameter: guessParameter(h, parameters), alsoRead })
  })
  return out
}

/** The description without a mapped column's text, which the eleven folded into it (header order, so the last match). */
function withoutCell(description: string, cell: string): string {
  const at = description.lastIndexOf(cell)
  if (at < 0) return description
  return `${description.slice(0, at)}${description.slice(at + cell.length)}`.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Rows as read from the paste (`readDraft`), with the mapped extra columns
 * filled and their text taken back out of the description. Rows typed by
 * hand keep what they have. Unmapped columns stay in the description, as
 * they always did.
 */
export function withPastedExtras(rows: readonly EquipmentDraftRow[], text: string, columns: readonly PastedColumn[]): EquipmentDraftRow[] {
  const mapped = columns.filter((c): c is PastedColumn & { readonly parameter: string } => c.parameter !== null && c.index >= 0)
  if (mapped.length === 0) return [...rows]
  const { lines, split } = pastedLines(text)
  return rows.map((row) => {
    const line = /^line-(\d+)$/.exec(row.key)?.[1]
    if (line === undefined || split === null) return row
    const cells = split(lines[Number(line) - 1] ?? '')
    const extras: Record<string, string> = { ...row.extras }
    for (const c of mapped) {
      const v = cells[c.index]?.trim()
      if (v) extras[c.parameter] = v
    }
    let description = row.description
    for (const c of [...mapped].reverse()) {
      const v = cells[c.index]?.trim()
      if (v && !c.alsoRead) description = withoutCell(description, v)
    }
    return Object.keys(extras).length > 0 ? { ...row, description, extras } : row
  })
}

const text = (n: number | null): string => (n === null ? '' : String(n))

/** Pasted text as preview rows. Splitting and units read the same under any edition; horsepower is checked per row. */
export function readDraft(nec: NecEdition | null, text: string): EquipmentDraftRow[] {
  return text.trim() ? draftFromSchedule(readEquipmentSchedule(nec ?? UNIT_READING_EDITION, text).rows) : []
}

export function draftFromSchedule(rows: readonly EquipmentScheduleRow[]): EquipmentDraftRow[] {
  return rows.map((r) => ({
    key: `line-${r.line}`,
    mark: r.tag,
    description: r.description,
    quantity: String(r.quantity),
    voltage: text(r.voltageV),
    phase: text(r.phases),
    load: r.loadText,
    gasMbh: r.mbh === null ? '' : String(Math.round(r.mbh * 100) / 100),
    coldWater: r.coldWater,
    hotWater: r.hotWater,
    waste: r.waste,
    connection: r.connection,
  }))
}

/** What a row will become, or why it can't yet, in plain words. */
export interface DraftCheck {
  readonly quantity: number
  readonly voltageV: number | null
  readonly phases: 1 | 3 | null
  readonly va: number | null
  readonly vaBasis: string
  readonly mbh: number | null
  readonly loadClass: LoadClass
  readonly problems: readonly string[]
  /** The extra columns' values as each parameter stores them. Absent: the row has none. */
  readonly extras?: Readonly<Record<string, ParamValue>>
}

const DESIGNATOR = /^[A-Z]{1,3}-?\d{1,3}[A-Z]?$/i

/** Reads units in a typed load ("17 kW") when the project has no NEC edition; never used for a code table. */
const UNIT_READING_EDITION = necEdition('2023')

export function checkDraftRow(nec: NecEdition | null, row: EquipmentDraftRow, taken: ReadonlySet<string>, parameters: readonly EquipmentParameter[] = []): DraftCheck {
  const problems: string[] = []
  const mark = row.mark.trim()
  if (mark === '') problems.push('Give it a mark (K-14), so it can be found in Not placed yet and on the one-line.')
  else if (mark.length > 32) problems.push('Keep the mark to 32 characters.')
  else if (taken.has(mark.toLowerCase())) problems.push(`${mark} is already used, in the model or higher up this list; give it its own mark.`)
  if (row.description.trim() === '' && mark === '') problems.push('Say what it is (Fryer, gas).')

  const q = row.quantity.trim() === '' ? 1 : Number(row.quantity)
  const quantity = Number.isInteger(q) && q >= 1 && q <= 50 ? q : 1
  if (!(Number.isInteger(q) && q >= 1)) problems.push(`Qty "${row.quantity}" isn't a whole number of items.`)
  else if (q > 50) problems.push('More than 50 of one item: add it as a load on a space instead, or split the row.')

  const v = row.voltage.trim() === '' ? null : numberIn(row.voltage)
  if (row.voltage.trim() !== '' && (v === null || v < 100 || v > 600)) problems.push(`Volts "${row.voltage}" isn't a voltage between 100 and 600.`)
  const voltageV = v !== null && v >= 100 && v <= 600 ? v : null

  const p = row.phase.trim() === '' ? null : numberIn(row.phase)
  if (row.phase.trim() !== '' && p !== 1 && p !== 3) problems.push(`Phase "${row.phase}" is 1 or 3.`)
  const phases: 1 | 3 | null = p === 1 || p === 3 ? p : null

  // Only horsepower reads a code table; kW, VA and amps read the same under any edition.
  const load =
    nec === null && /\bhp\b/i.test(row.load)
      ? { va: null, vaBasis: '', problem: 'Horsepower needs the NEC edition to read its table current: set it in the project’s Code Study, or give the amps.' }
      : loadFromText(nec ?? UNIT_READING_EDITION, row.load, voltageV, phases)
  if (load.problem) problems.push(load.problem)

  const g = row.gasMbh.trim() === '' ? null : numberIn(row.gasMbh)
  if (row.gasMbh.trim() !== '' && (g === null || g <= 0)) problems.push(`Gas "${row.gasMbh}" isn't an input in MBH (80).`)
  const mbh = g !== null && g > 0 ? g : null

  const anything = load.va !== null || mbh !== null || row.coldWater.trim() !== '' || row.hotWater.trim() !== '' || row.waste.trim() !== ''
  // A row that names a fixture or gas appliance ("Range, gas") adds its proposed starter load, so it isn't empty.
  const proposes = !anything && proposeEquipmentLoads({ mark, description: row.description, mbh: null, coldWater: '', hotWater: '', waste: '' }).length > 0
  if (!anything && !proposes && !load.problem && problems.length === 0) problems.push('Nothing to add up: give a load, gas MBH, or water and waste sizes.')

  const extras: Record<string, ParamValue> = {}
  for (const [name, raw] of Object.entries(row.extras ?? {})) {
    const p = parameters.find((x) => x.name === name)
    if (!p) {
      problems.push(`The column for ${name} isn't a parameter this list knows any more; choose another or Not used.`)
      continue
    }
    const read = parseParameterText(p, raw)
    if ('problem' in read) problems.push(read.problem)
    else if (read.value !== null) extras[name] = read.value
  }

  const { cls } = suggestLoadClass(`${row.description} ${mark}`)
  return { quantity, voltageV, phases, va: load.va, vaBasis: load.vaBasis, mbh, loadClass: cls, problems, ...(Object.keys(extras).length > 0 ? { extras } : {}) }
}

/** Every row's check; marks must be unique against the model and against rows above. */
export function checkDraft(nec: NecEdition | null, model: Pick<ModelState, 'elements'> | null, rows: readonly EquipmentDraftRow[], parameters: readonly EquipmentParameter[] = []): DraftCheck[] {
  const taken = new Set<string>()
  if (model) for (const p of elementsOfKind(model.elements, 'part')) if (p.mark) taken.add(p.mark.toLowerCase())
  return rows.map((row) => {
    const check = checkDraftRow(nec, row, taken, parameters)
    for (const m of unitMarks(row.mark.trim(), check.quantity)) taken.add(m.toLowerCase())
    return check
  })
}

/** K-14 for one; K-14.1, K-14.2 for two of the same item. */
export function unitMarks(mark: string, quantity: number): string[] {
  if (quantity <= 1) return [mark]
  return Array.from({ length: quantity }, (_, i) => `${mark}.${i + 1}`)
}

const num = (name: string, label: string, unit: ParamDef['unit']): ParamDef => ({ name, label, kind: 'number', unit, min: 0 })
const txt = (name: string, label: string): ParamDef => ({ name, label, kind: 'text' })

/** Equipment with a water connection and nothing else is a plumbing fixture; the rest is equipment. */
function categoryOf(check: DraftCheck, row: EquipmentDraftRow): PartCategory {
  const water = row.coldWater.trim() !== '' || row.hotWater.trim() !== '' || row.waste.trim() !== ''
  return water && check.va === null && check.mbh === null ? 'plumbing_fixture' : 'mechanical_equipment'
}

/**
 * The one part type every listed item uses, per category. No drawn connectors:
 * the electrical engine circuits it by its nameplate (voltage, phases, load),
 * gas sizing reads `input_mbh`, and the water and waste sizes are as written.
 */
export function listedEquipmentType(category: PartCategory, extraParams: readonly ParamDef[] = []): PartTypeDefinition {
  return {
    familyName: category === 'plumbing_fixture' ? 'Fixture, from an equipment list' : 'Equipment, from an equipment list',
    typeName: 'Listed item',
    category,
    description: 'An item from a pasted equipment list. Set its values in its properties; draw it from Not placed yet.',
    typeParams: [],
    typeValues: {},
    instanceParams: [
      txt('description', 'Description'),
      num('voltage', 'Voltage', 'v'),
      num('phases', 'Phases', 'none'),
      num('load_va', 'Load', 'va'),
      txt('load_class', 'Load class'),
      num('input_mbh', 'Gas input (MBH)', 'none'),
      txt('cw_size', 'Cold water'),
      txt('hw_size', 'Hot water'),
      txt('waste_size', 'Waste'),
      txt('connection', 'Connection'),
      CONNECTION_TYPE_PARAM,
      txt('circuit', 'Circuit'),
      ...extraParams,
    ],
    connectors: [],
    geometry: [{ kind: 'box', center: [0, 0, 450], size: [600, 600, 900] }],
    symbol: [{ kind: 'rect', center: [0, 0], size: [600, 600] }],
    tagFields: ['mark'],
    source: { kind: 'builtin', libraryVersion: 'equipment-list@1' },
  }
}

export const LISTED_TYPE_IDS: Readonly<Record<'mechanical_equipment' | 'plumbing_fixture', string>> = {
  mechanical_equipment: 'type:listed-equipment@1',
  plumbing_fixture: 'type:listed-fixture@1',
}

function valuesOf(row: EquipmentDraftRow, check: DraftCheck): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  const description = row.description.trim()
  if (description) out.description = description
  if (check.voltageV !== null) out.voltage = check.voltageV
  if (check.phases !== null) out.phases = check.phases
  if (check.va !== null) {
    out.load_va = check.va
    out.load_class = check.loadClass
  }
  if (check.mbh !== null) out.input_mbh = check.mbh
  if (row.coldWater.trim()) out.cw_size = row.coldWater.trim()
  if (row.hotWater.trim()) out.hw_size = row.hotWater.trim()
  if (row.waste.trim()) out.waste_size = row.waste.trim()
  const connection = row.connection.trim()
  if (connection) {
    if (DESIGNATOR.test(connection)) out.connection_type = connection.toUpperCase()
    else out.connection = connection
  }
  // The eleven win: an extra column never overwrites what they read.
  for (const [name, v] of Object.entries(check.extras ?? {})) if (!(name in out)) out[name] = v
  return out
}

/** One step of a `batch_edits`. */
type EditStep = Extract<Command, { type: 'batch_edits' }>['commands'][number]

export interface PlannedEquipmentBatch {
  readonly command: Command
  /** The ids of the parts it plans, in list order. */
  readonly partIds: readonly string[]
  readonly count: number
}

/** One proposed plumbing or gas load for a row, with a key the dialog's checkboxes use. */
export interface RowLoadProposal {
  readonly key: string
  readonly rowKey: string
  readonly mark: string
  readonly description: string
  readonly quantity: number
  readonly load: ProposedEquipmentLoad
}

/**
 * The plumbing and gas loads the list would add (ROADMAP F4): one per row and
 * trade, from the row's own values or a matching starter type. Rows with
 * problems propose nothing until they're fixed.
 */
export function proposedLoads(rows: readonly EquipmentDraftRow[], checks: readonly DraftCheck[]): RowLoadProposal[] {
  const out: RowLoadProposal[] = []
  rows.forEach((row, i) => {
    const check = checks[i]
    if (!check || check.problems.length > 0) return
    for (const load of proposeEquipmentLoads({ mark: row.mark, description: row.description, mbh: check.mbh, coldWater: row.coldWater, hotWater: row.hotWater, waste: row.waste })) {
      out.push({ key: `${row.key}:${load.kind}`, rowKey: row.key, mark: row.mark.trim(), description: row.description.trim(), quantity: check.quantity, load })
    }
  })
  return out
}

/** Totals of the accepted proposals, every unit counted: what the loads table gains. */
export function proposalTotals(proposals: readonly RowLoadProposal[], accepted: ReadonlySet<string>): { readonly cfh: number; readonly wsfu: number; readonly dfu: number; readonly count: number } {
  let cfh = 0
  let wsfu = 0
  let dfu = 0
  let count = 0
  for (const p of proposals) {
    if (!accepted.has(p.key)) continue
    count += p.quantity
    cfh += (p.load.cfh ?? 0) * p.quantity
    wsfu += (p.load.wsfuTotal ?? 0) * p.quantity
    dfu += (p.load.dfu ?? 0) * p.quantity
  }
  const r = (n: number) => Math.round(n * 100) / 100
  return { cfh: r(cfh), wsfu: r(wsfu), dfu: r(dfu), count }
}

type LoadSpec = Extract<EditStep, { type: 'create_load' }>['loads'][number]

function loadSpecFor(p: RowLoadProposal, partId: string, mark: string, id: string): LoadSpec {
  const values = p.load.values
  return {
    id,
    anchor: { kind: 'part', partId },
    mark,
    ...(p.load.connectionType ? { connectionType: p.load.connectionType } : {}),
    ...(Object.keys(values).length > 0 ? { values } : {}),
    ...(p.load.kind === 'gas' ? { service: 'gas' as const } : {}),
    ...(p.description ? { note: p.description.slice(0, 200) } : {}),
    source: p.load.fromStarter ? { kind: 'engineer', ref: `Starter connection type ${p.load.connectionType ?? ''}, to verify`.slice(0, 200) } : { kind: 'vendor_doc', ref: 'Pasted equipment list' },
  }
}

/**
 * The list as one undoable change: a `plan_part` per unit, then the accepted
 * plumbing and gas loads on those units (`create_load` anchored to each
 * planned part). Rows with problems are refused here too (the dialog keeps
 * Add disabled until there are none), so a half-read list never lands.
 */
export function plannedEquipmentBatch(model: Pick<ModelState, 'elements'>, rows: readonly EquipmentDraftRow[], checks: readonly DraftCheck[], newId: (prefix: string) => string, accepted: readonly RowLoadProposal[] = [], parameters: readonly EquipmentParameter[] = []): PlannedEquipmentBatch | { readonly refused: string } {
  if (rows.length === 0) return { refused: 'Paste a list first.' }
  const bad = checks.findIndex((c) => c.problems.length > 0)
  if (bad >= 0) return { refused: `Row ${bad + 1} (${rows[bad]?.mark || 'no mark'}): ${checks[bad]?.problems[0] ?? ''}` }
  const categoryAt = (i: number): 'plumbing_fixture' | 'mechanical_equipment' => {
    const check = checks[i]
    const row = rows[i]
    return check && row && categoryOf(check, row) === 'plumbing_fixture' ? 'plumbing_fixture' : 'mechanical_equipment'
  }
  // Extra columns become parameters of the listed type: declared once per type, before any part sets them.
  const used = new Map<'plumbing_fixture' | 'mechanical_equipment', EquipmentParameter[]>()
  checks.forEach((c, i) => {
    for (const name of Object.keys(c.extras ?? {})) {
      const p = parameters.find((x) => x.name === name)
      if (!p) continue
      const list = used.get(categoryAt(i)) ?? []
      if (!list.some((x) => x.name === name)) list.push(p)
      used.set(categoryAt(i), list)
    }
  })
  const declarations: EditStep[] = []
  const newTypes = new Map<string, PartTypeDefinition>()
  for (const category of ['mechanical_equipment', 'plumbing_fixture'] as const) {
    const typeId = LISTED_TYPE_IDS[category]
    const params = used.get(category) ?? []
    if (model.elements[typeId]) {
      if (params.length === 0) continue
      const declared = declareParameters(model, typeId, params)
      if ('refused' in declared) return declared
      if (declared.command) declarations.push(declared.command)
      continue
    }
    const base = listedEquipmentType(category)
    const missing = undeclared(base, params)
    if ('refused' in missing) return missing
    newTypes.set(typeId, missing.instance.length > 0 ? listedEquipmentType(category, missing.instance) : base)
  }
  const commands: EditStep[] = [...declarations]
  const partIds: string[] = []
  const loads: LoadSpec[] = []
  rows.forEach((row, i) => {
    const check = checks[i]
    if (!check) return
    const typeId = LISTED_TYPE_IDS[categoryAt(i)]
    const partType = newTypes.get(typeId)
    const values = valuesOf(row, check)
    const mine = accepted.filter((p) => p.rowKey === row.key)
    for (const mark of unitMarks(row.mark.trim(), check.quantity)) {
      const partId = newId('part')
      partIds.push(partId)
      commands.push({ type: 'plan_part', partId, typeId, ...(partType ? { partType } : {}), mark, values, note: 'From the equipment list' })
      for (const p of mine) loads.push(loadSpecFor(p, partId, mark, newId('load')))
    }
  })
  const items = partIds.length
  if (loads.length > 0) commands.push({ type: 'create_load', loads })
  if (items > 500 || loads.length > 500) return { refused: `That is ${Math.max(items, loads.length)} ${items >= loads.length ? 'items' : 'loads'}; add up to 500 at a time.` }
  const loadWords = loads.length > 0 ? ` with ${loads.length} plumbing and gas load${loads.length === 1 ? '' : 's'}` : ''
  return { command: { type: 'batch_edits', label: `Add ${items} planned item${items === 1 ? '' : 's'} from the equipment list${loadWords}`, commands }, partIds, count: items }
}
