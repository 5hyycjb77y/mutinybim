/**
 * Facts read from a manufacturer's cut sheet (submittal data sheet): overall
 * dimensions, duct openings, pipe connections, electrical data, capacity,
 * weight, manufacturer and model. Pure: text lines in, facts out. Every fact
 * keeps the page and line it came from, so an agent (and the person
 * approving the save) can check each number against the sheet.
 *
 * Reads the way US cut sheets print values: 74", 74 in, 42-1/2", 42 1/2 in,
 * 6'-2", 1880 mm; "28 x 14", "208-230/3/60", "MCA 32.5 A".
 */

export interface CutSheetLine {
  /** 1-based page. */
  readonly page: number
  readonly text: string
}

export interface Source {
  readonly page: number
  readonly line: string
}

export interface Fact<T> {
  readonly value: T
  readonly source: Source
}

export type CutSheetKind = "rooftop_unit" | "air_terminal" | "water_heater"

export type OpeningRole = "supply" | "return" | "neck" | "outside_air" | "exhaust"

export interface Opening {
  readonly role: OpeningRole
  /** Millimetres. Rectangular openings have width × depth; round ones a diameter. */
  readonly widthMm?: number
  readonly depthMm?: number
  readonly diameterMm?: number
  /** Where its centre sits, millimetres from an edge, when the sheet says. */
  readonly fromEdge?: { readonly edge: "front" | "back" | "left" | "right"; readonly mm: number }
  readonly source: Source
}

export type PipeRole = "cold_water" | "hot_water" | "gas" | "relief" | "condensate" | "drain" | "recirculation"

export interface PipeConnection {
  readonly role: PipeRole
  readonly diameterMm: number
  readonly source: Source
}

export interface Electrical {
  readonly voltage?: Fact<number>
  readonly phase?: Fact<number>
  readonly hertz?: Fact<number>
  readonly mca?: Fact<number>
  readonly mop?: Fact<number>
  readonly fla?: Fact<number>
  readonly kw?: Fact<number>
}

export interface CutSheetFacts {
  readonly kind: Fact<CutSheetKind> | null
  readonly manufacturer: Fact<string> | null
  readonly model: Fact<string> | null
  readonly description: Fact<string> | null
  readonly lengthMm: Fact<number> | null
  readonly widthMm: Fact<number> | null
  readonly heightMm: Fact<number> | null
  readonly diameterMm: Fact<number> | null
  readonly faceSizeMm: Fact<number> | null
  readonly curbHeightMm: Fact<number> | null
  readonly openings: readonly Opening[]
  readonly pipes: readonly PipeConnection[]
  readonly electrical: Electrical
  readonly coolingTons: Fact<number> | null
  readonly airflowCfm: Fact<number> | null
  readonly heatingBtuh: Fact<number> | null
  readonly storageGallons: Fact<number> | null
  readonly recoveryGph: Fact<number> | null
  readonly weightLb: Fact<number> | null
}

const MM_PER_IN = 25.4

/** A length the way cut sheets print it, in millimetres: 42-1/2", 42 1/2 in, 6'-2", 74.0 in, 1880 mm, 3/4" (bare numbers are inches). */
export function parseLength(raw: string): number | null {
  const t = raw.trim().replace(/[″”]/g, '"').replace(/[′’]/g, "'")
  const ftIn = /^(\d+(?:\.\d+)?)\s*'\s*-?\s*(\d+(?:\.\d+)?)?(?:\s*-?\s*(\d+)\/(\d+))?\s*"?$/.exec(t)
  if (ftIn) {
    const inches = Number(ftIn[2] ?? 0) + (ftIn[3] && ftIn[4] ? Number(ftIn[3]) / Number(ftIn[4]) : 0)
    return round((Number(ftIn[1]) * 12 + inches) * MM_PER_IN)
  }
  const mm = /^(\d+(?:\.\d+)?)\s*mm$/i.exec(t)
  if (mm) return round(Number(mm[1]))
  const inch = /^(?:(\d+(?:\.\d+)?)(?:\s*[- ]\s*(\d+)\/(\d+))?|(\d+)\/(\d+))\s*(?:"|in\.?|inch(?:es)?)?$/i.exec(t)
  if (!inch) return null
  const whole = inch[1] !== undefined ? Number(inch[1]) : 0
  const frac = inch[2] && inch[3] ? Number(inch[2]) / Number(inch[3]) : inch[4] && inch[5] ? Number(inch[4]) / Number(inch[5]) : 0
  const v = whole + frac
  return v > 0 ? round(v * MM_PER_IN) : null
}

const round = (n: number) => Math.round(n * 100) / 100

/** One length token inside a line (the first match after `from`). */
const LEN = String.raw`(\d+'\s*-?\s*\d+(?:\.\d+)?(?:\s*-?\s*\d+\/\d+)?\s*"?|\d+(?:\.\d+)?(?:\s*[- ]\s*\d+\/\d+)?\s*(?:"|in\.?|inches|mm)|\d+\/\d+\s*(?:"|in\.?)|\d+(?:\.\d+)?)`
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)`
const num = (s: string) => Number(s.replace(/,/g, ""))

function lengthAfter(text: string, label: RegExp): number | null {
  const m = new RegExp(`(?:${label.source})[^0-9]{0,30}?${LEN}`, "i").exec(text)
  return m?.[1] ? parseLength(m[1]) : null
}

/** "28 x 14", "28" x 14"", "28 in x 14 in" → two lengths. */
function pairIn(text: string): [number, number] | null {
  const m = new RegExp(`${LEN}\\s*[x×X]\\s*${LEN}`).exec(text)
  if (!m?.[1] || !m[2]) return null
  const a = parseLength(m[1])
  const b = parseLength(m[2])
  return a && b ? [a, b] : null
}

/** "74 x 47 x 42-1/2" → three lengths. */
function tripleIn(text: string): [number, number, number] | null {
  const m = new RegExp(`${LEN}\\s*(?:L\\b)?\\s*[x×X]\\s*${LEN}\\s*(?:W\\b)?\\s*[x×X]\\s*${LEN}`).exec(text)
  if (!m?.[1] || !m[2] || !m[3]) return null
  const v = [parseLength(m[1]), parseLength(m[2]), parseLength(m[3])]
  return v[0] && v[1] && v[2] ? [v[0], v[1], v[2]] : null
}

function fact<T>(value: T, l: CutSheetLine): Fact<T> {
  return { value, source: { page: l.page, line: l.text.trim() } }
}

function firstNumber(lines: readonly CutSheetLine[], label: RegExp, unit?: RegExp): Fact<number> | null {
  for (const l of lines) {
    if (!label.test(l.text)) continue
    const m = new RegExp(`(?:${label.source})[^0-9]{0,40}?${NUM}${unit ? `\\s*(?:${unit.source})` : ""}`, "i").exec(l.text)
    if (m?.[1]) return fact(num(m[1]), l)
  }
  return null
}

function firstLength(lines: readonly CutSheetLine[], label: RegExp): Fact<number> | null {
  for (const l of lines) {
    if (!label.test(l.text)) continue
    const v = lengthAfter(l.text, label)
    if (v) return fact(v, l)
  }
  return null
}

function detectKind(lines: readonly CutSheetLine[]): Fact<CutSheetKind> | null {
  const tests: ReadonlyArray<[CutSheetKind, RegExp]> = [
    ["water_heater", /\bwater heater\b/i],
    ["rooftop_unit", /\b(roof\s*top|rooftop|packaged)\b.*\b(unit|heat pump|air conditioner|gas\/electric)\b|\bRTU\b/i],
    ["air_terminal", /\b(diffuser|register|grille)\b/i],
  ]
  for (const [kind, re] of tests) {
    const l = lines.find((x) => re.test(x.text))
    if (l) return fact(kind, l)
  }
  return null
}

function labelled(lines: readonly CutSheetLine[], label: RegExp): Fact<string> | null {
  for (const l of lines) {
    const m = new RegExp(`(?:${label.source})\\s*[:#.-]?\\s*(.+)$`, "i").exec(l.text)
    const v = m?.[1]?.trim()
    if (v) return fact(v.replace(/\s{2,}.*$/, ""), l)
  }
  return null
}

const OPENING_ROLES: ReadonlyArray<[OpeningRole, RegExp]> = [
  ["supply", /\bsupply\b.*\b(opening|connection|duct)\b/i],
  ["return", /\breturn\b.*\b(opening|connection|duct)\b/i],
  ["outside_air", /\boutside air\b.*\b(opening|intake|connection)\b/i],
  ["exhaust", /\bexhaust\b.*\b(opening|connection)\b/i],
  ["neck", /\b(neck|inlet)\b.*\b(size|diameter|round|connection)\b|\bneck\b/i],
]

function openings(lines: readonly CutSheetLine[]): Opening[] {
  const out: Opening[] = []
  for (const l of lines) {
    const role = OPENING_ROLES.find(([, re]) => re.test(l.text))?.[0]
    if (!role || out.some((o) => o.role === role)) continue
    const edge = /(?:cent(?:er|re)d?|centre line)?[^0-9]{0,20}?(\d+(?:\.\d+)?(?:\s*[- ]\s*\d+\/\d+)?\s*(?:"|in\.?))\s*from\s*(?:the\s*)?(front|back|rear|left|right)/i.exec(l.text)
    const fromEdge = edge?.[1] && edge[2] ? { edge: (edge[2].toLowerCase() === "rear" ? "back" : edge[2].toLowerCase()) as "front" | "back" | "left" | "right", mm: parseLength(edge[1]) ?? 0 } : undefined
    const sizeText = edge ? l.text.slice(0, edge.index) : l.text
    const pair = pairIn(sizeText)
    const round = /(?:round|dia(?:meter)?\.?|Ø)/i.test(sizeText) ? lengthAfter(sizeText, /(?:neck|inlet|opening|connection|size|diameter|dia\.?)/i) : null
    const source = { page: l.page, line: l.text.trim() }
    if (pair) out.push({ role, widthMm: pair[0], depthMm: pair[1], ...(fromEdge && fromEdge.mm > 0 ? { fromEdge } : {}), source })
    else if (round) out.push({ role, diameterMm: round, ...(fromEdge && fromEdge.mm > 0 ? { fromEdge } : {}), source })
  }
  return out
}

const PIPE_ROLES: ReadonlyArray<[PipeRole, RegExp]> = [
  ["cold_water", /\bcold water\b/i],
  ["hot_water", /\bhot water\b/i],
  ["recirculation", /\brecirc(?:ulation)?\b/i],
  ["gas", /\bgas (?:connection|inlet|supply)\b|\bgas\b.*\bNPT\b/i],
  ["relief", /\b(T\s*&\s*P|relief)\b/i],
  ["condensate", /\bcondensate\b/i],
  ["drain", /\bdrain\b/i],
]

function pipes(lines: readonly CutSheetLine[]): PipeConnection[] {
  const out: PipeConnection[] = []
  for (const l of lines) {
    const role = PIPE_ROLES.find(([, re]) => re.test(l.text))?.[0]
    if (!role || out.some((p) => p.role === role)) continue
    const m = new RegExp(`${LEN}\\s*(?:NPT|FPT|MPT|NPS|pipe|copper|connection)?`, "i").exec(l.text.replace(/^[^0-9]*/, ""))
    const d = m?.[1] ? parseLength(m[1]) : null
    if (d && d < 6 * MM_PER_IN) out.push({ role, diameterMm: d, source: { page: l.page, line: l.text.trim() } })
  }
  return out
}

function electrical(lines: readonly CutSheetLine[]): Electrical {
  let voltage: Fact<number> | undefined
  let phase: Fact<number> | undefined
  let hertz: Fact<number> | undefined
  for (const l of lines) {
    const vph = /\b(\d{3})(?:\s*[-/]\s*(\d{3}))?\s*(?:V|volts?)?\s*\/\s*([13])\s*(?:ph|phase)?\s*\/\s*(50|60)\b/i.exec(l.text)
    if (vph?.[1] && vph[3] && vph[4]) {
      voltage = fact(Number(vph[1]), l)
      phase = fact(Number(vph[3]), l)
      hertz = fact(Number(vph[4]), l)
      break
    }
  }
  voltage ??= firstNumber(lines, /\bvoltage\b/i) ?? undefined
  phase ??= firstNumber(lines, /\bphase\b/i) ?? undefined
  const mca = firstNumber(lines, /\b(?:MCA|min(?:imum)?\.?\s*circuit\s*amp(?:acity|s)?)\b/i) ?? undefined
  const mop = firstNumber(lines, /\b(?:MOP|MOCP|max(?:imum)?\.?\s*(?:over\s*-?\s*current|fuse|breaker)(?:\s*protection)?(?:\s*device)?)\b/i) ?? undefined
  const fla = firstNumber(lines, /\bFLA\b/i) ?? undefined
  const kwLine = lines.find((l) => /\b(element|input|heating)\b/i.test(l.text) && /\d(?:\.\d+)?\s*kW\b/i.test(l.text))
  const kwMatch = kwLine ? /(\d+(?:\.\d+)?)\s*kW\b/i.exec(kwLine.text) : null
  const kw = kwLine && kwMatch?.[1] ? fact(Number(kwMatch[1]), kwLine) : undefined
  return { ...(voltage ? { voltage } : {}), ...(phase ? { phase } : {}), ...(hertz ? { hertz } : {}), ...(mca ? { mca } : {}), ...(mop ? { mop } : {}), ...(fla ? { fla } : {}), ...(kw ? { kw } : {}) }
}

function dimensions(lines: readonly CutSheetLine[]): Pick<CutSheetFacts, "lengthMm" | "widthMm" | "heightMm"> {
  for (const l of lines) {
    if (!/\b(dimensions?|overall|L\s*x\s*W\s*x\s*H|cabinet size)\b/i.test(l.text)) continue
    const t = tripleIn(l.text)
    if (t) return { lengthMm: fact(t[0], l), widthMm: fact(t[1], l), heightMm: fact(t[2], l) }
  }
  return {
    lengthMm: firstLength(lines, /\b(?:overall\s*)?length\b/i),
    widthMm: firstLength(lines, /\b(?:overall\s*)?(?:width|depth)\b/i),
    heightMm: firstLength(lines, /\b(?:overall\s*|cabinet\s*)?height\b(?!\s*(?:of\s*)?curb)/i),
  }
}

/** Everything the sheet says that a part needs. Values it doesn't print are null (never guessed here). */
export function extractCutSheetFacts(lines: readonly CutSheetLine[]): CutSheetFacts {
  const dims = dimensions(lines)
  const face = (() => {
    for (const l of lines) {
      if (!/\bface\b/i.test(l.text)) continue
      const p = pairIn(l.text)
      if (p && Math.abs(p[0] - p[1]) < 1) return fact(p[0], l)
      const v = lengthAfter(l.text, /\bface(?:\s*size)?\b/i)
      if (v) return fact(v, l)
    }
    return null
  })()
  return {
    kind: detectKind(lines),
    manufacturer: labelled(lines, /\bmanufacturer\b/i),
    model: labelled(lines, /\bmodel(?:\s*(?:no\.?|number))?\b/i),
    description: labelled(lines, /\bdescription\b/i),
    ...dims,
    diameterMm: firstLength(lines, /\b(?:tank\s*|jacket\s*|overall\s*)?diameter\b/i),
    faceSizeMm: face,
    curbHeightMm: firstLength(lines, /\bcurb\s*height\b|\bheight\s*of\s*curb\b/i),
    openings: openings(lines),
    pipes: pipes(lines),
    electrical: electrical(lines),
    coolingTons: firstNumber(lines, /\b(?:nominal\s*)?cooling(?:\s*capacity)?\b/i, /tons?/i),
    airflowCfm: firstNumber(lines, /\b(?:nominal\s*|rated\s*|supply\s*)?air\s*flow\b|\bairflow\b|\bCFM\b/i),
    heatingBtuh: firstNumber(lines, /\b(?:heating\s*)?input\b|\bheating\s*capacity\b/i, /(?:BTU\/?H|BTUH|Btu\/h)/i),
    storageGallons: firstNumber(lines, /\b(?:storage|tank|nominal)\s*capacity\b|\bcapacity\b/i, /(?:gal(?:lons?)?|US gal)/i),
    recoveryGph: firstNumber(lines, /\brecovery\b/i, /(?:GPH|gal\/h)/i),
    weightLb: firstNumber(lines, /\b(?:operating|shipping|unit)?\s*weight\b/i, /(?:lbs?|pounds)/i),
  }
}
