import { SQRT3, type NecEdition } from "@permitzip/bim-calc";
import type { LoadClass } from "./demand";
import { motorFullLoad } from "./motor";
import { allocationClassOf, elementsOfKind, isAreaEstimate, loadAnchorOf, loadValueOf, modelSpaceLocator, paramValue, plannedParts, starterConnectionType, type ModelState, type ParamValue } from "@permitzip/bim-kernel";
import { numberIn } from "@permitzip/bim-units";

/**
 * Reading an equipment list someone pasted: a spreadsheet (tabs), a CSV, or
 * text copied out of a PDF table (columns of spaces). One reader for every
 * trade, so the kitchen consultant's schedule gives the electrical load, the
 * gas input and the water and drain connections of each row in one pass.
 *
 * Service size reads only the electrical columns (`readEquipmentList` in
 * electrical/service-size.ts); the Building Model's Equipment list reads them
 * all (`readEquipmentSchedule`). Both go through the same splitting, header
 * and load rules here, so a row reads the same way in both.
 *
 * The class suggestion is word matching on the description, nothing more.
 * Nothing here selects equipment (US 11,087,054 design rules).
 */

export interface ParsedEquipment {
  /** The row's line in the pasted text: non-blank lines counted from 1, the header row included. */
  readonly line: number;
  readonly tag: string;
  readonly description: string;
  readonly quantity: number;
  readonly voltageV: number | null;
  readonly phases: 1 | 3 | null;
  /** Load of one unit, VA; null when the row gave nothing to work it out from. */
  readonly va: number | null;
  /** How the VA was found: "1,320 W", "16 A x 208 V x √3", "2 hp (Table 430.250: 7.5 A) x 208 V x √3". */
  readonly vaBasis: string;
  readonly suggestedClass: LoadClass;
  readonly classBasis: string;
  readonly problem: string | null;
}

/** One row of an equipment schedule with every trade's columns. */
export interface EquipmentScheduleRow extends ParsedEquipment {
  /** The row's electrical load as written ("17 kW", "4.2 A", "2 hp"); "" when it gave none. The preview grid edits this. */
  readonly loadText: string;
  /** Gas input of one unit, MBH. */
  readonly mbh: number | null;
  /** Connection sizes as written on the schedule ('1/2"'). Information only. */
  readonly coldWater: string;
  readonly hotWater: string;
  readonly waste: string;
  readonly dfu: number | null;
  readonly wsfu: number | null;
  /** How it connects, as written: "Cord and plug", "Hardwired", "J-box", or a connection type ("E05"). */
  readonly connection: string;
}

export interface EquipmentList {
  readonly rows: readonly ParsedEquipment[];
  /** The line of the header row (non-blank lines counted from 1), or null when the paste has none. */
  readonly headerLine: number | null;
}

export interface EquipmentSchedule {
  readonly rows: readonly EquipmentScheduleRow[];
  readonly headerLine: number | null;
}

export interface EquipmentDefaults {
  readonly voltageV?: number;
  readonly phases?: 1 | 3;
}

// ---------------------------------------------------------------- load classes

const CLASS_WORDS: ReadonlyArray<readonly [LoadClass, RegExp]> = [
  ["kitchen", /\b(fryer|oven|range|griddle|grill|broiler|salamander|freezer|refrigerat\w*|cooler|reach[- ]in|walk[- ]in|warmer|holding|proofer|dish ?wash\w*|booster|ice (machine|maker)|steam\w*|kettle|mixer|slicer|prep|toaster|coffee|espresso|brewer|disposer|disposal|food|cook\w*|heat(ed)? (lamp|well|shelf)|merchandiser|blender|microwave|induction|wok|rethermalizer|chiller)\b/i],
  ["hvac", /\b(rtu|ahu|rooftop|condens\w*|heat pump|split|mau|make[- ]?up air|erv|doas|fcu|vrf|vav|air handl\w*|chiller|cooling tower|cu-\d+)\b/i],
  // A water heater is not space heating (it stays "other").
  ["heating", /\b(electric heat(?:ers?|ing)?|baseboard(?: heaters?)?|(?:unit|space|infrared|patio|radiant|wall|cabinet|ceiling|duct|garage|shop|electric) heaters?|uh-\d+|heat strip|strip heat(?:ers?)?|(?<!water |hot water )heaters?)\b/i],
  ["motor", /\b(motor|pump|fan|ef-\d+|exhaust|compressor|blower|conveyor|hood fan)\b/i],
  ["lighting", /\b(lights?|lighting|fixtures?|luminaires?|lts)\b/i],
  ["receptacle", /\b(receptacles?|recepts?|convenience|outlets?)\b/i],
];

export function suggestLoadClass(description: string): { cls: LoadClass; basis: string } {
  for (const [cls, re] of CLASS_WORDS) {
    const m = re.exec(description);
    if (m) return { cls, basis: `"${m[0]}" in the description` };
  }
  return { cls: "other", basis: "no class word in the description: counted at 100%" };
}

// ---------------------------------------------------------------- columns

type ElectricalColumn = "tag" | "description" | "quantity" | "voltage" | "phase" | "va" | "kva" | "w" | "kw" | "amps" | "hp";
type Column = ElectricalColumn | "mbh" | "btuh" | "cw" | "hw" | "waste" | "dfu" | "wsfu" | "connection";

const ELECTRICAL_HEADER_WORDS: ReadonlyArray<readonly [Column, RegExp]> = [
  ["tag", /^(tag|item|mark|no\.?|#|item ?no\.?|symbol|designator|k-?tag)$/i],
  ["description", /^(description|equipment|name|item description|desc\.?|equipment description)$/i],
  ["quantity", /^(qty|quantity|count|no\. ?req'?d)$/i],
  ["voltage", /^(volts?|voltage|v)$/i],
  ["phase", /^(ph|phase|phases|Ø|φ)$/i],
  ["kva", /^(kva)$/i],
  ["va", /^(va|load ?\(va\)|load)$/i],
  ["kw", /^(kw|load ?\(kw\))$/i],
  ["w", /^(w|watts?|load ?\(w\))$/i],
  ["amps", /^(a|amps?|fla|mca|current)$/i],
  ["hp", /^(hp|horsepower)$/i],
];

/** The other trades' columns a kitchen or fixture schedule carries. */
const SCHEDULE_HEADER_WORDS: ReadonlyArray<readonly [Column, RegExp]> = [
  ...ELECTRICAL_HEADER_WORDS,
  ["mbh", /^(mbh|gas|gas ?mbh|gas ?\(mbh\)|gas input|input ?\(mbh\)|mbtuh|kbtuh)$/i],
  ["btuh", /^(btu|btuh|btu\/h|btu\/hr|gas ?\(btuh?\))$/i],
  ["cw", /^(cw|dcw|cold|cold water|cw ?conn\.?)$/i],
  ["hw", /^(hw|dhw|hot|hot water|hw ?conn\.?)$/i],
  ["waste", /^(waste|drain|ind\.? ?waste|iw|dw|san\.?|sanitary)$/i],
  ["dfu", /^(dfu)$/i],
  ["wsfu", /^(wsfu|fu)$/i],
  ["connection", /^(conn\.?|connection|connection type|elec\.? ?conn\.?|type of connection|ct)$/i],
];

type Delimiter = "tab" | "csv" | "spaces";

/** One delimiter for the whole paste: tabs (a spreadsheet), commas when every row has them and none has a column gap (a CSV), else runs of spaces (a PDF). */
function delimiterOf(lines: readonly string[]): Delimiter {
  if (lines.some((l) => l.includes("\t"))) return "tab";
  if (lines.every((l) => l.includes(",")) && !lines.some((l) => /\S\s{2,}\S/.test(l))) return "csv";
  return "spaces";
}

function splitLine(line: string, by: Delimiter): string[] {
  if (by === "tab") return line.split("\t").map((c) => c.trim());
  if (by === "csv") return csvCells(line);
  return line.split(/\s{2,}|\s\|\s|\|/).map((c) => c.trim()).filter((c) => c !== "");
}

function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}


function fraction(text: string): number | null {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(text);
  if (m && m[1] && m[2]) {
    const whole = /(\d+)\s+(\d+)\s*\/\s*(\d+)/.exec(text);
    if (whole && whole[1] && whole[2] && whole[3]) return Number(whole[1]) + Number(whole[2]) / Number(whole[3]);
    return Number(m[1]) / Number(m[2]);
  }
  return numberIn(text);
}

type FreeText = Partial<Record<ElectricalColumn, number>> & { phase?: 1 | 3 };

/** Units written in a free-text cell: "1320W", "120V/1PH", "2 HP", "16A", "6 kW". */
function freeText(cells: readonly string[]): FreeText {
  const text = cells.join(" ");
  const out: FreeText = {};
  const grab = (re: RegExp) => {
    const m = re.exec(text);
    return m?.[1] ? fraction(m[1]) : null;
  };
  const kva = grab(/(\d[\d,.]*)\s*kva\b/i);
  const kw = grab(/(\d[\d,.]*)\s*kw\b/i);
  const va = grab(/(\d[\d,.]*)\s*va\b/i);
  const w = grab(/(\d[\d,.]*)\s*w(atts?)?\b/i);
  const hp = grab(/(\d+(?:\s+\d+\/\d+|\/\d+|\.\d+)?)\s*hp\b/i);
  const a = grab(/(\d[\d,.]*)\s*(?:a|amps?|fla|mca)\b/i);
  const v = grab(/(\d{3})\s*v\b/i);
  if (kva !== null) out.kva = kva;
  if (kw !== null) out.kw = kw;
  if (va !== null && kva === null) out.va = va;
  if (w !== null && kw === null) out.w = w;
  if (hp !== null) out.hp = hp;
  if (a !== null) out.amps = a;
  if (v !== null) out.voltage = v;
  if (/\b3\s*(ph|Ø|φ|phase)\b/i.test(text)) out.phase = 3;
  else if (/\b1\s*(ph|Ø|φ|phase)\b/i.test(text)) out.phase = 1;
  return out;
}

// ---------------------------------------------------------------- one row's load

export interface LoadValues {
  readonly kva?: number | null;
  readonly va?: number | null;
  readonly kw?: number | null;
  readonly w?: number | null;
  readonly hp?: number | null;
  readonly amps?: number | null;
}

export interface RowLoad {
  readonly va: number | null;
  readonly vaBasis: string;
  readonly problem: string | null;
}

/** One unit's load in VA from whichever of kVA, VA, kW, W, hp or amps the row gives (in that order). */
export function equipmentLoad(nec: NecEdition, values: LoadValues, voltageV: number | null, phases: 1 | 3 | null): RowLoad {
  const k3 = phases === 3 ? SQRT3 : 1;
  const { kva = null, va = null, kw = null, w = null, hp = null, amps = null } = values;
  if (kva !== null) return { va: Math.round(kva * 1000), vaBasis: `${kva} kVA`, problem: null };
  if (va !== null) return { va: Math.round(va), vaBasis: `${va.toLocaleString("en-US")} VA`, problem: null };
  if (kw !== null) return { va: Math.round(kw * 1000), vaBasis: `${kw} kW (power factor 1)`, problem: null };
  if (w !== null) return { va: Math.round(w), vaBasis: `${w.toLocaleString("en-US")} W (power factor 1)`, problem: null };
  if (hp !== null) {
    if (voltageV === null || phases === null) return { va: null, vaBasis: "", problem: `${hp} hp: give the voltage and phase so the table current can be read` };
    const flc = motorFullLoad(nec, hp, voltageV, phases);
    if (!flc) return { va: null, vaBasis: "", problem: `${hp} hp at ${voltageV} V ${phases}-phase isn't in Tables 430.248 / 430.250; give its amps` };
    return { va: Math.round(flc.amps * voltageV * k3), vaBasis: `${hp} hp (${flc.cite[0]?.text ?? "Table 430.250"}) x ${voltageV} V${phases === 3 ? " x √3" : ""}`, problem: null };
  }
  if (amps !== null) {
    if (voltageV === null) return { va: null, vaBasis: "", problem: `${amps} A: give the voltage` };
    return { va: Math.round(amps * voltageV * k3), vaBasis: `${amps} A x ${voltageV} V${phases === 3 ? " x √3" : ""}`, problem: null };
  }
  return { va: null, vaBasis: "", problem: "No load: give VA, W, kW, kVA, amps or hp" };
}

/**
 * A load typed in one cell ("17 kW", "4.2 A", "1,320 W", "2 hp", "5 kVA"), as
 * the Equipment list's preview grid takes it. A bare number says nothing about
 * its unit, so it is refused in plain words rather than guessed.
 */
export function loadFromText(nec: NecEdition, text: string, voltageV: number | null, phases: 1 | 3 | null): RowLoad {
  const t = text.trim();
  if (t === "") return { va: null, vaBasis: "", problem: null };
  const f = freeText([t]);
  if (f.kva === undefined && f.va === undefined && f.kw === undefined && f.w === undefined && f.hp === undefined && f.amps === undefined) {
    return { va: null, vaBasis: "", problem: numberIn(t) === null ? `"${t}" isn't a load: write it like 17 kW, 1,320 W, 4.2 A or 2 hp` : `Say what ${t} is: kW, W, VA, A or hp` };
  }
  return equipmentLoad(nec, f, voltageV, phases);
}

// ---------------------------------------------------------------- reading

interface RawRow {
  readonly line: number;
  readonly byCol: Partial<Record<Column, string>>;
  readonly cells: readonly string[];
  readonly hasHeader: boolean;
}

/** Cells of a line of PDF text with where each starts: runs of text split by two or more spaces (or a pipe). */
function spacedCells(line: string): { readonly text: string; readonly at: number }[] {
  const out: { text: string; at: number }[] = [];
  const re = /\S+(?: \S+)*/g;
  const plain = line.replace(/\|/g, " ");
  for (let m = re.exec(plain); m; m = re.exec(plain)) out.push({ text: m[0].trim(), at: m.index });
  return out;
}

/**
 * PDF text drops empty cells: "K-2  Charbroiler  1        180" has no Volts,
 * so by position 180 would land in Volts. Under a header, each cell belongs to
 * the header column it starts under (two characters of slack either way).
 */
function cellsUnder(line: string, starts: readonly number[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  for (const c of spacedCells(line)) {
    let k = 0;
    for (let j = 0; j < starts.length; j++) if ((starts[j] ?? 0) <= c.at + 2) k = j;
    out[k] = out[k] === undefined ? c.text : `${out[k]} ${c.text}`;
  }
  return out;
}

function readRaw(text: string, words: ReadonlyArray<readonly [Column, RegExp]>): { rows: RawRow[]; headerLine: number | null } {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, " ")).filter((l) => l.trim() !== "");
  const by = delimiterOf(lines);
  let header: Column[] | null = null;
  let headerStarts: number[] | null = null;
  let headerLine: number | null = null;
  const rows: RawRow[] = [];
  for (const [i, line] of lines.entries()) {
    const cells = splitLine(line, by);
    const asHeader = cells.map((c) => words.find(([, re]) => re.test(c.replace(/[()]/g, "").trim()))?.[0] ?? null);
    if (asHeader.filter((h) => h !== null).length >= 2 && cells.every((c) => numberIn(c) === null || /^(no\.?|#)$/i.test(c))) {
      const named = asHeader.map((h, k) => h ?? (k === 0 ? "tag" : "description"));
      // A plumbing schedule's W next to CW and HW is waste, not watts.
      header = named.includes("cw") || named.includes("hw") ? named.map((h) => (h === "w" ? "waste" : h)) : named;
      headerStarts = by === "spaces" ? spacedCells(line).map((c) => c.at) : null;
      headerLine = i + 1;
      continue;
    }
    const byCol: Partial<Record<Column, string>> = {};
    if (header) {
      // A full row reads left to right; only a row missing cells needs to know where its cells sit.
      const placed = headerStarts && headerStarts.length === header.length && cells.length < header.length ? cellsUnder(line, headerStarts) : cells;
      header.forEach((h, k) => (byCol[h] = [byCol[h], placed[k]].filter(Boolean).join(" ")));
    }
    rows.push({ line: i + 1, byCol, cells, hasHeader: header !== null });
  }
  return { rows, headerLine };
}

function electricalRow(nec: NecEdition, raw: RawRow, defaults: EquipmentDefaults): { row: ParsedEquipment; free: FreeText } | null {
  const { byCol, cells, hasHeader, line } = raw;
  const free = freeText(cells);
  const n = (c: ElectricalColumn): number | null => (byCol[c] !== undefined ? (c === "hp" ? fraction(byCol[c] ?? "") : numberIn(byCol[c] ?? "")) : (free[c] ?? null));
  const first = cells[0] ?? "";
  const tag = byCol.tag ?? (hasHeader ? "" : /^[A-Z]{1,3}[-.]?\d+[A-Z]?$/i.test(first) ? first : "");
  const description = byCol.description ?? cells.filter((c, k) => !(k === 0 && tag !== "") && (numberIn(c) === null || /[a-z]{3,}/i.test(c))).join(" ").trim();
  const quantity = Math.max(1, Math.round(n("quantity") ?? 1));
  const voltageV = n("voltage") ?? defaults.voltageV ?? null;
  const phaseText = byCol.phase;
  const phases: 1 | 3 | null = phaseText ? (numberIn(phaseText) === 3 ? 3 : 1) : (free.phase ?? defaults.phases ?? null);
  const load = equipmentLoad(nec, { kva: n("kva"), va: n("va"), kw: n("kw"), w: n("w"), hp: n("hp"), amps: n("amps") }, voltageV, phases);
  const { cls, basis } = suggestLoadClass(`${description} ${tag}`);
  if (!description && load.va === null) return null;
  return { row: { line, tag, description: description || tag || `Line ${line}`, quantity, voltageV, phases, va: load.va, vaBasis: load.vaBasis, suggestedClass: cls, classBasis: basis, problem: load.problem }, free };
}

/**
 * Read an equipment list's electrical columns: tab-separated (pasted from a
 * spreadsheet), CSV, or columns of text copied from a PDF. A header row names
 * the columns when there is one; otherwise each row's units ("1320 W",
 * "208V 3PH", "2 HP") are read from its text.
 */
export function readEquipmentList(nec: NecEdition, text: string, defaults: EquipmentDefaults = {}): EquipmentList {
  const { rows, headerLine } = readRaw(text, ELECTRICAL_HEADER_WORDS);
  const out: ParsedEquipment[] = [];
  for (const raw of rows) {
    const r = electricalRow(nec, raw, defaults);
    if (r) out.push(r.row);
  }
  return { rows: out, headerLine };
}

/** Read an equipment list into rows; see readEquipmentList for the header line too. */
export function parseEquipmentList(nec: NecEdition, text: string, defaults: EquipmentDefaults = {}): ParsedEquipment[] {
  return [...readEquipmentList(nec, text, defaults).rows];
}

const CONNECTION_WORDS = /\b(cord (?:and|&) plug|cord[- ]?connected|plug[- ]?in|hard ?wired|direct(?: connect(?:ion)?)?|j[- ]?box|junction box|disconnect)\b/i;

/** A connection size as written ('1/2"', "3/4 in", "2"), always ending in an inch mark; "" when the cell has no number. */
function sizeIn(cell: string | undefined): string {
  const t = cell?.trim() ?? "";
  if (t === "" || numberIn(t) === null) return "";
  return /"$/.test(t) ? t : `${t.replace(/\s*(in|inch|inches)\.?$/i, "")}"`;
}

/**
 * Read an equipment schedule with every trade's columns: the electrical load
 * (as service size reads it), gas input in MBH (Btu/h columns are converted),
 * cold and hot water and waste connection sizes, fixture units, and how each
 * item connects. A row with gas or water but no electrical load is fine (a gas
 * fryer); a row with nothing to add up says so in plain words.
 */
export function readEquipmentSchedule(nec: NecEdition, text: string, defaults: EquipmentDefaults = {}): EquipmentSchedule {
  const { rows, headerLine } = readRaw(text, SCHEDULE_HEADER_WORDS);
  const out: EquipmentScheduleRow[] = [];
  for (const raw of rows) {
    const r = electricalRow(nec, raw, defaults);
    if (!r) continue;
    const { byCol, cells } = raw;
    const all = cells.join(" ");
    const mbhCol = byCol.mbh !== undefined ? numberIn(byCol.mbh) : null;
    const btuhCol = byCol.btuh !== undefined ? numberIn(byCol.btuh) : null;
    const mbhFree = /(\d[\d,.]*)\s*(?:mbh|mbtuh|kbtuh)\b/i.exec(all);
    const btuFree = /(\d[\d,.]*)\s*btu(?:h|\/h(?:r)?)?\b/i.exec(all);
    const mbh = mbhCol ?? (btuhCol !== null ? btuhCol / 1000 : null) ?? (mbhFree?.[1] ? numberIn(mbhFree[1]) : null) ?? (btuFree?.[1] ? (numberIn(btuFree[1]) ?? 0) / 1000 : null);
    const loadCells = (["kva", "va", "kw", "w", "amps", "hp"] as const).flatMap((c) => (byCol[c] ? [`${byCol[c]} ${c === "amps" ? "A" : c === "kva" ? "kVA" : c === "kw" ? "kW" : c === "va" ? "VA" : c === "w" ? "W" : "hp"}`] : []));
    const f = r.free;
    const freeLoad = f.kva !== undefined ? `${f.kva} kVA` : f.va !== undefined ? `${f.va} VA` : f.kw !== undefined ? `${f.kw} kW` : f.w !== undefined ? `${f.w} W` : f.hp !== undefined ? `${f.hp} hp` : f.amps !== undefined ? `${f.amps} A` : "";
    const loadText = raw.hasHeader ? (loadCells[0] ?? "") : freeLoad;
    const connection = byCol.connection?.trim() || CONNECTION_WORDS.exec(all)?.[0] || "";
    const coldWater = sizeIn(byCol.cw);
    const hotWater = sizeIn(byCol.hw);
    const waste = sizeIn(byCol.waste);
    const dfu = byCol.dfu !== undefined ? numberIn(byCol.dfu) : null;
    const wsfu = byCol.wsfu !== undefined ? numberIn(byCol.wsfu) : null;
    const hasOther = (mbh !== null && mbh > 0) || coldWater !== "" || hotWater !== "" || waste !== "" || (dfu !== null && dfu > 0) || (wsfu !== null && wsfu > 0);
    const problem = r.row.va === null && !loadText && hasOther ? null : r.row.va === null && !loadText && !hasOther ? "Nothing to add up: give a load (kW, W, VA, A or hp), gas MBH, or water and drain sizes" : r.row.problem;
    out.push({ ...r.row, problem, loadText, mbh, coldWater, hotWater, waste, dfu, wsfu, connection });
  }
  return { rows: out, headerLine };
}

// ------------------------------------------------------------------ from the model

/** One row the model gives the Service size list. */
export interface ModelLoadRow {
  readonly tag: string;
  readonly description: string;
  readonly voltageV: number | null;
  readonly phases: 1 | 3 | null;
  readonly va: number;
  /** "planned item", "estimate on Kitchen". */
  readonly from: string;
}

const numeric = (v: ParamValue | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? numberIn(v) : null);

/**
 * What the model already knows before a service exists (ROADMAP E1): the
 * planned items with an electrical load (the pasted equipment list, rooftop
 * units) and the electrical estimates on spaces and zones. As list rows the
 * person sees and can correct in Service size, so its connected total is the
 * same 82 kW the service's Load summary shows once the items are circuited.
 * Indexed reads only (planned parts, load points).
 */
export function modelLoadRows(model: Pick<ModelState, "elements">): ModelLoadRow[] {
  const elements = model.elements;
  const rows: ModelLoadRow[] = [];
  for (const part of plannedParts(elements)) {
    const type = elements[part.typeId];
    if (type?.kind !== "part_type") continue;
    const va = numeric(paramValue(type.definition, part.values, "load_va"));
    if (va === null || va <= 0) continue;
    const v = numeric(paramValue(type.definition, part.values, "voltage"));
    const ph = numeric(paramValue(type.definition, part.values, "phases"));
    const description = paramValue(type.definition, part.values, "description");
    rows.push({ tag: part.mark || "", description: typeof description === "string" && description ? description : type.definition.familyName, voltageV: v, phases: ph === 1 || ph === 3 ? ph : null, va, from: "planned item" });
  }
  const locator = modelSpaceLocator(elements);
  for (const lp of elementsOfKind(elements, "load_point")) {
    if (!isAreaEstimate(lp)) continue;
    const va = loadValueOf(elements, lp, locator).va;
    if (va <= 0) continue;
    const anchor = loadAnchorOf(lp);
    const scope = anchor.kind === "space" || anchor.kind === "zone" ? elements[anchor.id] : undefined;
    const where = scope?.kind === "space" || scope?.kind === "zone" ? scope.name : "the project";
    const cls = allocationClassOf(elements, lp);
    rows.push({ tag: lp.mark ?? "", description: `${cls ? `${cls.charAt(0).toUpperCase()}${cls.slice(1)}` : "Load"} estimate (${where})`, voltageV: null, phases: null, va, from: `estimate on ${where}` });
  }
  return rows;
}

// ------------------------------------------------------------------ plumbing and gas loads from a row

/**
 * What a listed item needs from plumbing and gas (ROADMAP F4, P1), as load
 * rows on the one load lifecycle: each proposal becomes a `create_load` anchored
 * to the planned item, so it counts in the loads table, the gas and water
 * totals and the schedules, and fulfils when the item is drawn and piped.
 *
 * A value the row gives wins (its MBH, DFU, WSFU, sizes). Otherwise a row whose
 * words match a starter connection type proposes that type (a door-type
 * dishwasher → DW: 1.5 hot WSFU, 2 DFU, 35 gal/h), labelled as starter values to
 * verify. An item the row calls electric never gets a gas load. Nothing is
 * selected for the engineer: every row is a proposal they accept or drop.
 */
export interface EquipmentLoadInput {
  readonly mark: string;
  readonly description: string;
  /** Gas input of one unit, MBH, as the row gives it. */
  readonly mbh: number | null;
  readonly coldWater: string;
  readonly hotWater: string;
  readonly waste: string;
  readonly dfu?: number | null;
  readonly wsfu?: number | null;
}

export interface ProposedLoadValues {
  readonly mbh?: number;
  readonly wsfu_cold?: number;
  readonly wsfu_hot?: number;
  readonly wsfu_total?: number;
  readonly dfu?: number;
  readonly gph_demand?: number;
  readonly sizes?: Readonly<Partial<Record<"cw" | "hw" | "w" | "g", string>>>;
}

export interface ProposedEquipmentLoad {
  readonly kind: "gas" | "plumbing";
  /** A starter connection type the load takes its values from ("DW"); null when the row's own values are the load. */
  readonly connectionType: string | null;
  /** The row's own values (absent when the connection type carries them). */
  readonly values: ProposedLoadValues;
  /** Where the numbers come from, in words. */
  readonly basis: string;
  readonly fromStarter: boolean;
  /** For display, per unit. */
  readonly mbh: number | null;
  /** Natural gas at 1,000 Btu/cf (IFGC 402.2), per unit. */
  readonly cfh: number | null;
  readonly wsfuTotal: number | null;
  readonly dfu: number | null;
}

interface StarterMatch {
  readonly designator: string;
  readonly words: string;
}

const PLUMBING_WORDS: ReadonlyArray<readonly [RegExp, StarterMatch]> = [
  [/\bdish ?wash\w*/i, { designator: "DW", words: "commercial dishwasher" }],
  [/\b(three|3)[- ]?(compartment|comp\.?)\b/i, { designator: "SK3", words: "three-compartment sink" }],
  [/\b(two|2)[- ]?(compartment|comp\.?)\b/i, { designator: "SK2", words: "two-compartment sink" }],
  [/\b(one|1)[- ]?(compartment|comp\.?)\b|\b(prep|bar|vegetable) sinks?\b/i, { designator: "SK1", words: "one-compartment sink" }],
  [/\bhand ?(sink|wash)\w*/i, { designator: "HS", words: "hand sink" }],
  [/\b(mop|service|janitor'?s?) (sink|basin|receptor)\b/i, { designator: "MS", words: "mop sink" }],
  [/\bfloor sinks?\b/i, { designator: "FS", words: "floor sink" }],
  [/\bfloor drains?\b/i, { designator: "FD", words: "floor drain" }],
  [/\bice (maker|machine)s?\b/i, { designator: "IM", words: "ice maker" }],
];

const GAS_WORDS: ReadonlyArray<readonly [RegExp, StarterMatch]> = [
  [/\bwater heater\b/i, { designator: "WH-GT", words: "gas tankless water heater" }],
  [/\bfryers?\b/i, { designator: "G-FRYER", words: "gas fryer" }],
  [/\b(range|[46810][- ]?(burner|top))\b/i, { designator: "G-RANGE", words: "gas range" }],
  [/\b(griddle|grill|flat ?top|charbroiler)\b/i, { designator: "G-GRILL", words: "gas flat top grill" }],
];

const NATURAL_GAS_BTU_PER_CF = 1000;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function matchOf(table: ReadonlyArray<readonly [RegExp, StarterMatch]>, text: string): StarterMatch | null {
  for (const [re, m] of table) if (re.test(text)) return m;
  return null;
}

function sizesOf(input: EquipmentLoadInput, gas: boolean): ProposedLoadValues["sizes"] | undefined {
  const s: Partial<Record<"cw" | "hw" | "w" | "g", string>> = {};
  if (!gas) {
    if (input.coldWater.trim()) s.cw = input.coldWater.trim();
    if (input.hotWater.trim()) s.hw = input.hotWater.trim();
    if (input.waste.trim()) s.w = input.waste.trim();
  }
  return Object.keys(s).length > 0 ? s : undefined;
}

/** The plumbing and gas loads one listed item would add. Empty when the row gives nothing and matches nothing. */
export function proposeEquipmentLoads(input: EquipmentLoadInput): ProposedEquipmentLoad[] {
  const text = `${input.description} ${input.mark}`;
  const electric = /\belectric\b/i.test(text) && !/\bgas\b/i.test(text);
  const out: ProposedEquipmentLoad[] = [];

  // Gas: the row's MBH, else a gas item by its words.
  const gasMatch = electric ? null : /\bgas\b/i.test(text) ? matchOf(GAS_WORDS, text) : null;
  const gasStarter = gasMatch ? starterConnectionType(gasMatch.designator) : null;
  if (input.mbh !== null && input.mbh > 0) {
    out.push({ kind: "gas", connectionType: null, values: { mbh: input.mbh }, basis: `${input.mbh} MBH from the list`, fromStarter: false, mbh: input.mbh, cfh: round2((input.mbh * 1000) / NATURAL_GAS_BTU_PER_CF), wsfuTotal: null, dfu: null });
  } else if (gasMatch && gasStarter?.quantities?.mbh !== undefined) {
    const mbh = gasStarter.quantities.mbh;
    out.push({ kind: "gas", connectionType: gasMatch.designator, values: {}, basis: `Starter input for a ${gasMatch.words} (${gasMatch.designator}), ${mbh} MBH: verify against the cut sheet`, fromStarter: true, mbh, cfh: round2((mbh * 1000) / NATURAL_GAS_BTU_PER_CF), wsfuTotal: null, dfu: null });
  }

  // Water and drain: the row's fixture units, else a fixture by its words; a gas water heater is a source, not a water load.
  const heater = /\bwater heater\b/i.test(text);
  const rowDfu = input.dfu ?? null;
  const rowWsfu = input.wsfu ?? null;
  const sizes = sizesOf(input, false);
  const plumbingMatch = heater ? null : matchOf(PLUMBING_WORDS, text);
  const starter = plumbingMatch ? starterConnectionType(plumbingMatch.designator) : null;
  if ((rowDfu !== null && rowDfu > 0) || (rowWsfu !== null && rowWsfu > 0)) {
    const values: ProposedLoadValues = { ...(rowWsfu !== null && rowWsfu > 0 ? { wsfu_total: rowWsfu } : {}), ...(rowDfu !== null && rowDfu > 0 ? { dfu: rowDfu } : {}), ...(sizes ? { sizes } : {}) };
    out.push({ kind: "plumbing", connectionType: null, values, basis: [rowWsfu ? `${rowWsfu} WSFU` : "", rowDfu ? `${rowDfu} DFU` : ""].filter(Boolean).join(", ") + " from the list", fromStarter: false, mbh: null, cfh: null, wsfuTotal: rowWsfu, dfu: rowDfu });
  } else if (plumbingMatch && starter) {
    const q = starter.quantities ?? {};
    const wsfuTotal = q.wsfu_total ?? null;
    const dfu = q.dfu ?? null;
    const what = [wsfuTotal !== null ? `${wsfuTotal} WSFU` : "", dfu !== null ? `${dfu} DFU` : "", q.gph_demand !== undefined ? `${q.gph_demand} gal/h` : ""].filter(Boolean).join(", ");
    out.push({ kind: "plumbing", connectionType: plumbingMatch.designator, values: sizes ? { sizes } : {}, basis: `Starter values for a ${plumbingMatch.words} (${plumbingMatch.designator})${what ? `: ${what}` : ""}; verify for permit work`, fromStarter: true, mbh: null, cfh: null, wsfuTotal, dfu });
  } else if (sizes && !heater) {
    out.push({ kind: "plumbing", connectionType: null, values: { sizes }, basis: "Connection sizes from the list; give its fixture units to count it in sizing", fromStarter: false, mbh: null, cfh: null, wsfuTotal: null, dfu: null });
  }
  return out;
}

/** The rows as a tab-separated list the Service size reader takes (header included). */
export function modelLoadListText(rows: readonly ModelLoadRow[]): string {
  const kw = (va: number) => String(Math.round(va) / 1000);
  return ["Mark\tDescription\tQty\tVolts\tPh\tkW", ...rows.map((r) => [r.tag, r.description.replace(/\t/g, " "), "1", r.voltageV ?? "", r.phases ?? "", kw(r.va)].join("\t"))].join("\n");
}

export { numberIn };
