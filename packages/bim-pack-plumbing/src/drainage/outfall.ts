import { builtinPartType, partNode, pipeDims, runNeighbours, walkToOutfall, type BimElement, type Command, type ElementId, type GravityOutfall, type GravityOutfallRow, type ModelState, type RunSegment } from "@permitzip/bim-kernel";
import { drainageRoleOf, sewerConnectionOf } from "./read";

type Elements = Readonly<Record<string, BimElement>>;

const MM_PER_FT = 304.8;
const MM_PER_IN = 25.4;

/**
 * Drains walked to the street sewer (round 13 P13). Plumbing's sewer
 * connection (a manhole on the public main, or a tap on it) is a
 * `kernel.gravity_outfall` row, so the kernel's walk ends there exactly as it
 * ends at a civil add-on's storm structure. The findings read the drawn pipe
 * between a fixture and the outfall: the inverts it reaches, its slope, and
 * the rim the floors sit below. Nothing is guessed: a missing invert or rim
 * says what to add.
 */

/** A sewer connection as an outfall: a public sewer can surcharge, so it always asks about backwater. */
export const SEWER_CONNECTION_OUTFALL: GravityOutfallRow = {
  id: "sewer_connection",
  label: "Sewer connection",
  kinds: ["part"],
  read: (el, elements) => {
    const c = sewerConnectionOf(elements, el.id);
    return c ? { elementId: c.id, label: c.label, invertMm: c.invertMm, rimMm: c.rimMm, backwater: true } : null;
  },
};

export type OutfallWalkFindingCode = "no_outfall" | "invert_missing" | "below_invert" | "runs_uphill" | "rim_missing" | "backwater_required";

export interface OutfallWalkFinding {
  readonly code: OutfallWalkFindingCode;
  readonly message: string;
  /** What Select highlights (the low point, the uphill pipe, the branch). */
  readonly selectIds: readonly ElementId[];
  /** The fix the Checklist offers, in words, what it places, and on which pipe. */
  readonly fix?: { readonly label: string; readonly places: OutfallFixPart; readonly at: ElementId };
}

/** What a sewer walk fix places: the starter sewage ejector or backwater valve. */
export type OutfallFixPart = "ejector" | "backwater_valve";

/** The starter part types the fixes place (Plumbing's library). */
export const OUTFALL_FIX_TYPE_IDS: Readonly<Record<OutfallFixPart, string>> = { ejector: "builtin:plumbing-sewage-ejector@1", backwater_valve: "builtin:plumbing-backwater-valve@1" };

/** One drawn pipe on the walk, in flow order: its invert where flow enters and where it leaves. */
export interface OutfallProfileRow {
  readonly segmentId: ElementId;
  readonly upstreamInvertMm: number;
  readonly downstreamInvertMm: number;
  /** Fall toward the outfall, in/ft; negative when it rises. */
  readonly slopeInPerFt: number;
}

export interface OutfallWalkReport {
  readonly outfall: GravityOutfall | null;
  readonly path: readonly ElementId[];
  readonly profile: readonly OutfallProfileRow[];
  readonly findings: readonly OutfallWalkFinding[];
}

const ft = (mm: number): string => (Math.round((mm / MM_PER_FT) * 10) / 10).toLocaleString("en-US");

function levelFloorMm(elements: Elements, levelId: ElementId | undefined): number | null {
  const level = levelId ? elements[levelId] : undefined;
  return level?.kind === "level" ? level.elevationMm : null;
}

function levelName(elements: Elements, levelId: ElementId | undefined): string | null {
  const level = levelId ? elements[levelId] : undefined;
  return level?.kind === "level" ? level.name : null;
}

/** A pipe's invert at a point on its centreline, mm above project zero. */
function invertAt(elements: Elements, seg: RunSegment, z: number): number | null {
  const floor = levelFloorMm(elements, seg.levelId);
  if (floor === null) return null;
  const inside = seg.size.shape === "pipe" ? pipeDims(seg.size).idMm : 0;
  return floor + z - inside / 2;
}

/** The walk's pipes in flow order, each oriented by which of its ends meets the next record. */
function profileOf(elements: Elements, path: readonly ElementId[]): OutfallProfileRow[] {
  const out: OutfallProfileRow[] = [];
  path.forEach((id, i) => {
    const seg = elements[id];
    if (seg?.kind !== "run_segment" || seg.domain !== "pipe") return;
    const next = path[i + 1];
    const endLeads = next !== undefined && seg.links.end?.elementId === next;
    const startLeads = next !== undefined && seg.links.start?.elementId === next;
    const down = startLeads && !endLeads ? seg.start : seg.end;
    const up = down === seg.start ? seg.end : seg.start;
    const upInvert = invertAt(elements, seg, up.z);
    const downInvert = invertAt(elements, seg, down.z);
    if (upInvert === null || downInvert === null) return;
    const planFt = Math.hypot(seg.end.x - seg.start.x, seg.end.y - seg.start.y) / MM_PER_FT;
    out.push({ segmentId: seg.id, upstreamInvertMm: upInvert, downstreamInvertMm: downInvert, slopeInPerFt: planFt > 1e-6 ? (upInvert - downInvert) / MM_PER_IN / planFt : 0 });
  });
  return out;
}

function startLevel(elements: Elements, start: BimElement | undefined, profile: readonly OutfallProfileRow[]): ElementId | undefined {
  if (start?.kind === "part" || start?.kind === "run_segment" || start?.kind === "run_fitting") return start.levelId;
  const first = profile[0] ? elements[profile[0].segmentId] : undefined;
  return first?.kind === "run_segment" ? first.levelId : undefined;
}

/** The drawn drain from `fromId` to its outfall, with what is wrong on the way, in words. */
export function outfallWalk(model: ModelState, fromId: ElementId): OutfallWalkReport {
  const elements = model.elements;
  const walk = walkToOutfall(model, fromId);
  if ("refused" in walk) return { outfall: null, path: [], profile: [], findings: [{ code: "no_outfall", message: walk.refused, selectIds: [fromId] }] };
  const { outfall, path } = walk;
  const profile = profileOf(elements, path);
  const findings: OutfallWalkFinding[] = [];

  for (const row of profile) {
    if (row.slopeInPerFt < -1e-3) {
      findings.push({ code: "runs_uphill", message: `${row.segmentId} runs uphill toward ${outfall.label}: slope it down toward ${outfall.label}`, selectIds: [row.segmentId] });
    }
  }

  const last = profile[profile.length - 1];
  if (outfall.invertMm === null) {
    findings.push({ code: "invert_missing", message: `Can't check the fall to ${outfall.label} yet: add its invert`, selectIds: [outfall.elementId] });
  } else if (last && last.downstreamInvertMm < outfall.invertMm - 0.5) {
    const low = profile.reduce((a, b) => (b.downstreamInvertMm < a.downstreamInvertMm ? b : a), last);
    findings.push({
      code: "below_invert",
      message: `Building sewer reaches ${outfall.label} ${ft(outfall.invertMm - last.downstreamInvertMm)} ft below its invert: it can't drain by gravity`,
      selectIds: [low.segmentId],
      fix: { label: "Add an ejector here", places: "ejector", at: low.segmentId },
    });
  }

  if (outfall.backwater) {
    const start = elements[fromId];
    const levelId = startLevel(elements, start, profile);
    const floor = levelFloorMm(elements, levelId);
    const protectedByValve = path.some((id) => drainageRoleOf(elements, elements[id]) === "backwater_valve");
    if (outfall.rimMm === null) {
      findings.push({ code: "rim_missing", message: `Can't check for backwater yet: add ${outfall.label}'s rim`, selectIds: [outfall.elementId] });
    } else if (floor !== null && floor < outfall.rimMm - 0.5 && !protectedByValve) {
      const branch = profile[0]?.segmentId ?? fromId;
      findings.push({
        code: "backwater_required",
        message: `Fixtures on ${levelName(elements, levelId) ?? "this level"} sit below ${outfall.label}'s rim: a backwater valve is required on their branch`,
        selectIds: [branch],
        fix: { label: "Place a backwater valve", places: "backwater_valve", at: branch },
      });
    }
  }
  return { outfall, path, profile, findings };
}

/**
 * The command a fix runs: the starter ejector at the low point's downstream
 * end, or the starter backwater valve halfway along the branch, on that
 * pipe's level at its height. The part arrives placed and unconnected; the
 * person connects it on the pipe. Refuses in words when Plumbing's starter
 * library isn't here.
 */
export function outfallFixCommand(model: ModelState, fix: NonNullable<OutfallWalkFinding["fix"]>, partId: string): Command | { readonly refused: string } {
  const seg = model.elements[fix.at];
  if (seg?.kind !== "run_segment") return { refused: `${fix.at} isn't a drawn pipe any more: walk the drain again` };
  const typeId = OUTFALL_FIX_TYPE_IDS[fix.places];
  const pinned = model.elements[typeId]?.kind === "part_type";
  const entry = pinned ? undefined : builtinPartType(typeId);
  if (!pinned && !entry) return { refused: `${fix.places === "ejector" ? "A sewage ejector" : "A backwater valve"} comes from Plumbing and gas's starter library, which isn't on here: turn on Plumbing and gas` };
  const at = fix.places === "ejector" ? seg.end : { x: (seg.start.x + seg.end.x) / 2, y: (seg.start.y + seg.end.y) / 2, z: (seg.start.z + seg.end.z) / 2 };
  return { type: "place_part", partId, typeId, ...(entry ? { partType: entry.definition } : {}), levelId: seg.levelId, position: { x: at.x, y: at.y }, offsetMm: at.z };
}

/** The pipes a gravity network starts from (an end that meets a fixture or nothing), reached from `outfallId`, one per level (the first found). */
function upstreamHeads(elements: Elements, outfallId: ElementId): ElementId[] {
  const out = elements[outfallId];
  if (out?.kind !== "part") return [];
  const starts = Object.keys(out.links ?? {}).map((c) => partNode(out.id, c));
  const seen = new Set<string>(starts);
  const queue = [...starts];
  const byLevel = new Map<string, ElementId>();
  for (let i = 0; i < queue.length; i += 1) {
    for (const next of runNeighbours(elements, queue[i] as string)) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      const el = elements[next];
      if (el?.kind !== "run_segment" || el.domain !== "pipe") continue;
      const openEnd = [el.links.start, el.links.end].some((l) => l === undefined || (elements[l.elementId]?.kind === "part" && l.elementId !== outfallId));
      if (openEnd && !byLevel.has(el.levelId)) byLevel.set(el.levelId, el.id);
    }
  }
  return [...byLevel.values()];
}

/** Every finding on the drawn drains that reach one outfall, walked from each level's upstream pipe; each said once. */
export function outfallWalkFindingsAt(model: ModelState, outfallId: ElementId): OutfallWalkFinding[] {
  const out: OutfallWalkFinding[] = [];
  const said = new Set<string>();
  for (const head of upstreamHeads(model.elements, outfallId)) {
    for (const f of outfallWalk(model, head).findings) {
      const key = `${f.code}\u0000${f.message}`;
      if (said.has(key)) continue;
      said.add(key);
      out.push(f);
    }
  }
  return out;
}
