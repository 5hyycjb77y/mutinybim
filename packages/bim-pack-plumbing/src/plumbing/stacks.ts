import { pipeCarriesQuantity } from "../fields/plumbing";
import { roomOf, runNeighbours, floorAt, levelElevationOf, elementsOfKind } from "@permitzip/bim-kernel";
import type { RunSegment, BimElement, ElementId, Level } from "@permitzip/bim-kernel";
import { advanceVerticalRunIndex, bottomEnd, chainAt, endHeightMm, verticalRunIndex, type VerticalChain, type VerticalRunFilter, type VerticalRunIndex } from "./chains";
import { namedVerticalRuns, verticalRunSettings } from "./element";
import type { NamedVerticalRun } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Stacks (ROADMAP P6): a drainage, vent or storm vertical run, read as the
 * plumbing drawings name it. `4"//S/K/L//19` is size // system / rooms served
 * // stack number (Plumbing Demo 2, 11:14). Every value is read from the drawn
 * pipe and the plumbing engine each time; a named record (types.ts) adds only
 * the number, name and the two codes when a person overrides them.
 */

const IN = 25.4;
const FT = 304.8;

/** Pipe systems whose vertical runs are stacks. */
export const STACK_SYSTEM_KINDS = ["sanitary", "vent", "storm"] as const;
const STACK_KINDS: ReadonlySet<string> = new Set(STACK_SYSTEM_KINDS);

/** A drawn run that never crosses a floor counts as a stack once it rises this far (one storey; a fixture drop doesn't). */
export const STACK_MIN_RISE_MM = 8 * FT;

const SYSTEM_LETTER: Readonly<Record<(typeof STACK_SYSTEM_KINDS)[number], string>> = { sanitary: "S", vent: "V", storm: "ST" };

export const stackFilter: VerticalRunFilter = (elements, seg) => {
  if (seg.domain !== "pipe") return false;
  const sys = elements[seg.systemId];
  return sys?.kind === "mep_system" && STACK_KINDS.has(sys.systemKind);
};

export interface StackOffset {
  readonly segmentId: ElementId;
  /** Plan length of the jog, mm. */
  readonly lengthMm: number;
  /** "2'-6\" east". */
  readonly text: string;
}

export interface StackFloor {
  readonly levelId: ElementId;
  readonly levelName: string;
  /** Largest nominal size on this floor, inches. */
  readonly sizeIn: number | null;
  /** Drainage fixture units the stack carries leaving this floor (its lowest piece here); null on a vent. */
  readonly dfu: number | null;
  readonly pieces: readonly ElementId[];
  readonly offsets: readonly StackOffset[];
}

export interface StackView {
  /** The run's key (its lowest piece id), stable while that piece stays. */
  readonly key: ElementId;
  readonly record: NamedVerticalRun | null;
  readonly number: string | null;
  readonly name: string | null;
  readonly systemId: ElementId;
  readonly systemName: string;
  readonly systemCode: string;
  readonly systemCodeTyped: boolean;
  /** Rooms the stack's branches reach, in the order they join from the top down. */
  readonly rooms: readonly string[];
  readonly servesCode: string;
  readonly servesTyped: boolean;
  /** Size at the base, inches. */
  readonly sizeIn: number | null;
  /** Drainage fixture units at the base; null on a vent. */
  readonly dfuAtBase: number | null;
  /** `4"//S/K/L//19`; the number is "?" until it has one. */
  readonly tag: string;
  /** Bottom to top. */
  readonly floors: readonly StackFloor[];
  readonly chain: VerticalChain;
}

/** A named stack whose pipe is gone (redrawn or deleted): it says so instead of disappearing. */
export interface LostStack {
  readonly record: NamedVerticalRun;
  readonly reason: string;
}

// ------------------------------------------------------------ text

/** 4 → 4", 1.5 → 1-1/2", 2.5 → 2-1/2", 1.25 → 1-1/4". */
export function inchText(inches: number): string {
  const whole = Math.floor(inches + 1e-6);
  const frac = inches - whole;
  const eighths = Math.round(frac * 8);
  if (eighths === 0) return `${whole}"`;
  if (eighths === 8) return `${whole + 1}"`;
  const g = eighths % 4 === 0 ? 4 : eighths % 2 === 0 ? 2 : 1;
  const f = `${eighths / g}/${8 / g}`;
  return whole > 0 ? `${whole}-${f}"` : `${f}"`;
}

function feetInchesText(mm: number): string {
  const totalIn = Math.round(mm / IN);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn % 12;
  return ft > 0 ? `${ft}'-${inch}"` : `${inch}"`;
}

function compass(dx: number, dy: number): string {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  const dirs = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
  return dirs[(Math.round(a / 45) + 8) % 8] ?? "east";
}

/** The rooms-served code a tag prints: each room's initial ("Kitchen", "Laundry" → "K/L"). */
export function roomsCode(rooms: readonly string[]): string {
  const out: string[] = [];
  for (const r of rooms) {
    const word = r.replace(/^\s*\d+[A-Z]?\s+/i, "").trim();
    const initial = word.charAt(0).toUpperCase();
    if (initial && !out.includes(initial)) out.push(initial);
  }
  return out.join("/");
}

/** `4"//S/K/L//19`: size // system / rooms served // number. Parts with no value drop with their slash. */
export function stackTagText(parts: { readonly sizeIn: number | null; readonly systemCode: string; readonly servesCode: string; readonly number: string | null }): string {
  const size = parts.sizeIn === null ? "" : inchText(parts.sizeIn);
  const middle = [parts.systemCode, parts.servesCode].filter((s) => s.trim() !== "").join("/");
  return `${size}//${middle}//${parts.number ?? "?"}`;
}

// ------------------------------------------------------------ reads

function levelsLowToHigh(elements: Elements): Level[] {
  return [...elementsOfKind(elements, "level")].sort((a, b) => a.elevationMm - b.elevationMm);
}

function midHeight(elements: Elements, seg: RunSegment): number {
  return (endHeightMm(elements, seg, "start") + endHeightMm(elements, seg, "end")) / 2;
}

function floorsOf(elements: Elements, chain: VerticalChain, drainage: boolean): StackFloor[] {
  const levels = levelsLowToHigh(elements);
  const byLevel = new Map<string, { level: Level | null; pieces: RunSegment[]; offsets: RunSegment[] }>();
  const slot = (seg: RunSegment) => {
    // A piece belongs to the floor it runs through (its middle); a model with no levels uses the piece's own.
    const level = floorAt(levels, midHeight(elements, seg)) ?? null;
    const key = level?.id ?? seg.levelId;
    let s = byLevel.get(key);
    if (!s) byLevel.set(key, (s = { level, pieces: [], offsets: [] }));
    return s;
  };
  for (const id of chain.pieces) {
    const seg = elements[id];
    if (seg?.kind === "run_segment") slot(seg).pieces.push(seg);
  }
  for (const id of chain.offsets) {
    const seg = elements[id];
    if (seg?.kind === "run_segment") slot(seg).offsets.push(seg);
  }
  const floors: StackFloor[] = [];
  for (const [key, s] of byLevel) {
    const sizes = s.pieces.map((p) => (p.size.shape === "pipe" ? p.size.nominalMm / IN : 0)).filter((n) => n > 0);
    const lowest = [...s.pieces].sort((a, b) => endHeightMm(elements, a, bottomEnd(elements, a)) - endHeightMm(elements, b, bottomEnd(elements, b)))[0];
    const dfu = drainage && lowest ? (pipeCarriesQuantity(elements, lowest, "dfu") ?? null) : null;
    const offsets = s.offsets.map((o): StackOffset => {
      const dx = o.end.x - o.start.x;
      const dy = o.end.y - o.start.y;
      const lengthMm = Math.hypot(dx, dy);
      return { segmentId: o.id, lengthMm, text: `${feetInchesText(lengthMm)} ${compass(dx, dy)}` };
    });
    const levelName = s.level?.name ?? (elements[key]?.kind === "level" ? (elements[key] as Level).name : "");
    floors.push({ levelId: (s.level?.id ?? key) as ElementId, levelName, sizeIn: sizes.length > 0 ? Math.round(Math.max(...sizes) * 1000) / 1000 : null, dfu: dfu === null ? null : Math.round(dfu * 100) / 100, pieces: s.pieces.map((p) => p.id), offsets });
  }
  const elevationOf = (f: StackFloor) => (elements[f.levelId]?.kind === "level" ? levelElevationOf(elements, f.levelId) : 0);
  return floors.sort((a, b) => elevationOf(a) - elevationOf(b));
}

const MAX_BRANCH_WALK = 4000;

/** Rooms the stack's branches reach, from the top down: each hosted branch is walked away from the stack to its fixtures and loads. */
function roomsServed(elements: Elements, chain: VerticalChain): string[] {
  const inChain = new Set<string>([...chain.pieces, ...chain.offsets, ...chain.fittings]);
  const rooms: string[] = [];
  const seen = new Set<string>(inChain);
  let budget = MAX_BRANCH_WALK;
  const add = (el: BimElement | undefined) => {
    if (!el) return;
    let name: string | null = null;
    if (el.kind === "part") {
      const v = el.values.room;
      if (typeof v === "string" && v.trim()) name = v.trim();
    }
    if (!name && (el.kind === "part" || el.kind === "load_point")) {
      const r = roomOf(elements, el);
      if (r) name = r.name.trim() || r.number.trim() || null;
    }
    if (name && !rooms.includes(name)) rooms.push(name);
  };
  for (const pid of [...chain.pieces].reverse()) {
    const piece = elements[pid];
    if (piece?.kind !== "run_segment") continue;
    for (const branchId of piece.branches) {
      const stack: string[] = [branchId];
      seen.add(branchId);
      while (stack.length > 0 && budget-- > 0) {
        const n = stack.pop() as string;
        const hash = n.indexOf("#");
        add(elements[hash >= 0 ? n.slice(0, hash) : n]);
        for (const m of runNeighbours(elements, n)) {
          if (seen.has(m)) continue;
          seen.add(m);
          stack.push(m);
        }
      }
    }
  }
  return rooms;
}

function viewOf(elements: Elements, chain: VerticalChain, record: NamedVerticalRun | null): StackView {
  const sys = elements[chain.systemId];
  const kind = sys?.kind === "mep_system" ? sys.systemKind : "sanitary";
  const drainage = kind === "sanitary" || kind === "storm";
  const floors = floorsOf(elements, chain, drainage);
  const rooms = roomsServed(elements, chain);
  const derivedSystem = SYSTEM_LETTER[kind as keyof typeof SYSTEM_LETTER] ?? "";
  const systemCode = record?.systemCode ?? derivedSystem;
  const servesCode = record?.serves ?? roomsCode(rooms);
  const base = floors[0];
  const sizeIn = base?.sizeIn ?? null;
  const number = record?.number ?? null;
  return {
    key: chain.key,
    record,
    number,
    name: record?.name ?? null,
    systemId: chain.systemId,
    systemName: sys?.kind === "mep_system" ? sys.name : "",
    systemCode,
    systemCodeTyped: record?.systemCode !== undefined,
    rooms,
    servesCode,
    servesTyped: record?.serves !== undefined,
    sizeIn,
    dfuAtBase: base?.dfu ?? null,
    tag: stackTagText({ sizeIn, systemCode, servesCode, number }),
    floors,
    chain,
  };
}

function isStackRun(elements: Elements, chain: VerticalChain): boolean {
  if (chain.topMm - chain.bottomMm >= STACK_MIN_RISE_MM - 1) return true;
  const levels = levelsLowToHigh(elements);
  const floors = new Set<string>();
  for (const id of chain.pieces) {
    const seg = elements[id];
    if (seg?.kind === "run_segment") floors.add(floorAt(levels, midHeight(elements, seg))?.id ?? seg.levelId);
  }
  return floors.size >= 2;
}

/** The index of drawn runs that could be stacks, kept per model state (see chains.ts). */
export function stackRunIndex(elements: Elements): VerticalRunIndex {
  return verticalRunIndex(elements, stackFilter);
}

/** After an edit: reuse every run the edit didn't touch. */
export function advanceStackRunIndex(base: Elements, next: Elements, changedIds: Iterable<string>): VerticalRunIndex {
  return advanceVerticalRunIndex(base, next, changedIds, stackFilter);
}

/** The named record whose pipe is in this run (the first by number when two name the same run). */
function recordFor(elements: Elements, chain: VerticalChain): NamedVerticalRun | null {
  const members = new Set<string>([...chain.pieces, ...chain.offsets]);
  const hits = namedVerticalRuns(elements).filter((r) => members.has(r.pipeId));
  hits.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  return hits[0] ?? null;
}

export interface StackList {
  /** Named stacks by number, then the unnamed ones (by height of their base, then key). */
  readonly stacks: readonly StackView[];
  readonly lost: readonly LostStack[];
}

/** Every stack: each named one, and every drawn run tall enough to be one. `index` lets a caller pass an advanced index. */
export function stacksOf(elements: Elements, index: VerticalRunIndex = stackRunIndex(elements)): StackList {
  const named: StackView[] = [];
  const unnamed: StackView[] = [];
  const used = new Set<string>();
  const lost: LostStack[] = [];
  for (const r of namedVerticalRuns(elements)) {
    const chain = index.byMember.get(r.pipeId) ?? null;
    if (!chain) {
      const el = elements[r.pipeId];
      lost.push({ record: r, reason: el ? `Stack ${r.number}'s pipe is no longer vertical sanitary, vent or storm pipe; pick its pipe again` : `Stack ${r.number}'s pipe was deleted or redrawn; pick its pipe again` });
    }
  }
  for (const chain of index.chains) {
    const record = recordFor(elements, chain);
    if (!record && !isStackRun(elements, chain)) continue;
    if (record) used.add(record.id);
    (record ? named : unnamed).push(viewOf(elements, chain, record));
  }
  named.sort((a, b) => (a.number ?? "").localeCompare(b.number ?? "", undefined, { numeric: true }));
  unnamed.sort((a, b) => a.chain.bottomMm - b.chain.bottomMm || a.key.localeCompare(b.key));
  return { stacks: [...named, ...unnamed], lost };
}

/** The stack an element is part of (a piece, an offset, a joint), walked on its own: no full-model read. */
export function stackAt(elements: Elements, id: ElementId): StackView | null {
  const chain = chainAt(elements, id, stackFilter);
  if (!chain) return null;
  const record = recordFor(elements, chain);
  if (!record && !isStackRun(elements, chain)) return null;
  return viewOf(elements, chain, record);
}

/** The next free stack number ("1", "2"…): one more than the highest number in use. */
export function nextStackNumber(elements: Elements, taken: Iterable<string> = []): string {
  let max = 0;
  for (const n of [...namedVerticalRuns(elements).map((r) => r.number), ...taken]) {
    const v = Number.parseInt(n, 10);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return String(max + 1);
}

/** The project's base-of-stack check: pipe diameters, or null when it is off (the default). */
export function stackBaseClearanceDiameters(elements: Elements): number | null {
  return verticalRunSettings(elements)?.baseClearanceDiameters ?? null;
}
