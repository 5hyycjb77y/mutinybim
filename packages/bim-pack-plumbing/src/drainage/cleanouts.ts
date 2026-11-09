import {
  add3,
  insertPartOnRun,
  len3,
  levelElevationOf,
  nominalInOf,
  runLabel,
  scale3,
  segmentAxis,
  serviceOf,
  straightPiece,
  sub3,
  type BimElement,
  type Command,
  type EditBatchCommand,
  type ElementId,
  type GhostPlacement,
  type ModelState,
  type PartTypeDefinition,
  type ProposerAnswer,
  type ProposerDef,
  type ProposerRequest,
  type RunSegment,
} from "@permitzip/bim-kernel";
import { builtinPartType, executeCommand } from "@permitzip/bim-kernel";
import { isPackRefusal } from "@permitzip/bim-kernel/packs";
import { sewerConnectionOf } from "./read";
import { CLEANOUT_PROPOSAL_WORDS } from "../ui";

/**
 * Cleanouts proposed on a selected drain (round 14 P14). The drain is walked
 * from the selected pieces along its own ends — through bends, transitions
 * and in-line parts, never along branches — and cleanouts are proposed as
 * ghosts where they are usually wanted:
 *
 *   - the upper end of the horizontal drain (also the base of a stack that turns into it),
 *   - each change of direction greater than 45°,
 *   - every 100 ft of developed length,
 *   - where the drain meets the sewer connection.
 *
 * A spot that already has a cleanout within 3 ft is skipped. Approve puts
 * each cleanout on the pipe through the kernel's `insertPartOnRun`, all in
 * one undo step. Firm or code specifics (spacing for small drains, a
 * jurisdiction's amendments) are the firm's to set; the spacing here is an
 * option with this default.
 */

export const CLEANOUT_PROPOSER_ID = "plumbing.cleanouts";
/** The starter in-line cleanout (4"); other sizes are the same type at the drain's size. */
export const CLEANOUT_INLINE_TYPE_ID = "builtin:plumbing-cleanout-inline@1";

const FT = 304.8;
const IN = 25.4;
const DEFAULT_SPACING_FT = 100;
const NEAR_EXISTING_MM = 3 * FT;
/** Clear distance from a bend or an end to the cleanout's near face. */
const CLEAR_MM = 150;

type Elements = Readonly<Record<string, BimElement>>;

export type CleanoutSpot = "upper_end" | "direction_change" | "spacing" | "sewer_connection";

/** A proposed cleanout: where it goes on which pipe, as the generic ghost plus the run position Approve needs. */
export interface CleanoutGhost extends GhostPlacement {
  readonly segmentId: ElementId;
  /** Along the pipe from its start (mm): where the cleanout's middle goes. */
  readonly atMm: number;
  readonly spot: CleanoutSpot;
  /** The in-line cleanout type at this drain's size. */
  readonly partType: PartTypeDefinition;
}

export interface CleanoutAnswer extends ProposerAnswer {
  readonly ghosts: readonly CleanoutGhost[];
}

interface Piece {
  readonly seg: RunSegment;
  /** True when flow runs from the piece's end to its start (we walked it backwards). */
  readonly reversed: boolean;
  /** The fitting or part we arrived through (null for the first piece). */
  readonly via: BimElement | null;
}

function drainPiece(elements: Elements, id: string): RunSegment | null {
  const el = elements[id];
  if (el?.kind !== "run_segment" || el.domain !== "pipe") return null;
  const system = elements[el.systemId];
  return system?.kind === "mep_system" && serviceOf(system.systemKind) === "drainage" ? el : null;
}

const upright = (seg: RunSegment): boolean => {
  const d = sub3(seg.end, seg.start);
  return Math.abs(d.z) > Math.hypot(d.x, d.y);
};

/** The next drain piece from `seg`'s `end`: directly, through a two-port fitting, or through a part's in-line pair. */
function stepFrom(elements: Elements, seg: RunSegment, end: "start" | "end"): { seg: RunSegment; arrived: "start" | "end"; via: BimElement | null } | null {
  const link = seg.links[end];
  if (!link) return null;
  const next = elements[link.elementId];
  if (next?.kind === "run_segment") return link.port === "start" || link.port === "end" ? { seg: next, arrived: link.port, via: null } : null;
  let out: { elementId: string; port: string } | undefined;
  if (next?.kind === "run_fitting" && !next.host && next.ports.length === 2) out = next.ports.find((p) => p.id !== link.port)?.link;
  if (next?.kind === "part") {
    const others = Object.entries(next.links ?? {}).filter(([port]) => port !== link.port);
    if (others.length === 1) out = others[0]?.[1];
  }
  const target = out ? drainPiece(elements, out.elementId) : null;
  if (!out || !target || (out.port !== "start" && out.port !== "end") || target.systemId !== seg.systemId) return null;
  return { seg: target, arrived: out.port, via: next ?? null };
}

/** The selected drain, upstream first: the horizontal pieces joined end to end with the selection. */
export function drainLine(elements: Elements, selected: readonly string[]): Piece[] {
  const start = selected.map((id) => drainPiece(elements, id)).find((s): s is RunSegment => s !== null && !upright(s));
  if (!start) return [];
  const seen = new Set<string>([start.id]);
  const walk = (from: RunSegment, end: "start" | "end"): Array<{ seg: RunSegment; arrived: "start" | "end"; via: BimElement | null }> => {
    const out: Array<{ seg: RunSegment; arrived: "start" | "end"; via: BimElement | null }> = [];
    let cur = from;
    let leave = end;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const s = stepFrom(elements, cur, leave);
      if (!s || seen.has(s.seg.id) || upright(s.seg)) break;
      seen.add(s.seg.id);
      out.push(s);
      cur = s.seg;
      leave = s.arrived === "start" ? "end" : "start";
    }
    return out;
  };
  const forward = walk(start, "end");
  const backward = walk(start, "start");
  // In start→end order of `start`: backward pieces reversed, then start, then forward.
  const ordered: Array<{ seg: RunSegment; reversed: boolean; via: BimElement | null }> = [];
  for (let i = backward.length - 1; i >= 0; i -= 1) {
    const b = backward[i];
    if (!b) continue;
    // Walking backwards we arrived at b's end that faces `start`: it runs start→end along the line when we arrived at its end.
    ordered.push({ seg: b.seg, reversed: b.arrived !== "end", via: null });
  }
  ordered.push({ seg: start, reversed: false, via: null });
  for (const f of forward) ordered.push({ seg: f.seg, reversed: f.arrived !== "start", via: f.via });
  // Flow runs downhill: the line's higher end is upstream.
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) return [];
  const zOf = (p: { seg: RunSegment; reversed: boolean }, which: "head" | "tail") => {
    const end = (which === "head") !== p.reversed ? "start" : "end";
    return levelElevationOf(elements, p.seg.levelId) + p.seg[end].z;
  };
  const flipped = zOf(last, "tail") > zOf(first, "head") + 0.5;
  const line = flipped ? [...ordered].reverse().map((p) => ({ ...p, reversed: !p.reversed })) : ordered;
  // `via` is what joins a piece to the one before it in flow order.
  return line.map((p, i) => ({ seg: p.seg, reversed: p.reversed, via: i === 0 ? null : joinBetween(elements, line[i - 1]?.seg, p.seg) }));
}

function joinBetween(elements: Elements, a: RunSegment | undefined, b: RunSegment): BimElement | null {
  if (!a) return null;
  for (const end of ["start", "end"] as const) {
    const link = a.links[end];
    if (!link) continue;
    if (link.elementId === b.id) return null;
    const el = elements[link.elementId];
    if (el?.kind === "run_fitting" && el.ports.some((p) => p.link?.elementId === b.id)) return el;
    if (el?.kind === "part" && Object.values(el.links ?? {}).some((l) => l.elementId === b.id)) return el;
  }
  return null;
}

const isCleanoutPart = (elements: Elements, el: BimElement | null | undefined): boolean => {
  if (el?.kind !== "part") return false;
  const type = elements[el.typeId];
  return type?.kind === "part_type" && /cleanout/i.test(type.definition.familyName);
};

/** The in-line cleanout type at a drain size. */
export function cleanoutInlineType(nominalIn: number): { readonly typeId: string; readonly definition: PartTypeDefinition } | null {
  const base = builtinPartType(CLEANOUT_INLINE_TYPE_ID);
  if (!base) return null;
  if (Math.abs(nominalIn - 4) < 0.01) return { typeId: CLEANOUT_INLINE_TYPE_ID, definition: base.definition };
  const label = `${Math.round(nominalIn * 100) / 100}"`;
  return {
    typeId: `plumbing.cleanout_inline.${String(Math.round(nominalIn * 100)).padStart(4, "0")}`,
    definition: { ...base.definition, typeName: `${label} wye with plug`, typeValues: { ...base.definition.typeValues, connection_size: nominalIn * IN } },
  };
}

const feet = (mm: number) => `${Math.round((mm / FT) * 10) / 10} ft`;

/** Propose cleanouts on the drain the selection is on. `roomIds` are the selected pieces (the proposer point's "where"). */
export function proposeCleanouts(model: Pick<ModelState, "elements" | "settings">, request: Pick<ProposerRequest, "roomIds" | "options">): CleanoutAnswer | { readonly refused: string } {
  const elements = model.elements;
  const line = drainLine(elements, request.roomIds);
  if (line.length === 0) return { refused: "Select a level drain pipe to propose cleanouts on" };
  const spacingFt = typeof request.options?.spacingFt === "number" && request.options.spacingFt > 0 ? request.options.spacingFt : DEFAULT_SPACING_FT;
  const notes: string[] = [];
  const raw: Array<{ piece: Piece; fromHeadMm: number; spot: CleanoutSpot; reason: string }> = [];
  const lengths = line.map((p) => len3(sub3(p.seg.end, p.seg.start)));
  const name = (p: Piece) => runLabel(elements, p.seg);

  const first = line[0];
  if (first) raw.push({ piece: first, fromHeadMm: CLEAR_MM, spot: "upper_end", reason: `the upper end of the drain (${name(first)})` });
  let sinceMm = 0;
  line.forEach((p, i) => {
    const total = lengths[i] ?? 0;
    if (i > 0 && p.via?.kind === "run_fitting" && p.via.fittingType === "elbow" && (p.via.angleDeg ?? 90) > 45 + 1e-6) {
      const prev = line[i - 1];
      if (prev) raw.push({ piece: prev, fromHeadMm: (lengths[i - 1] ?? 0) - CLEAR_MM, spot: "direction_change", reason: `a ${Math.round(p.via.angleDeg ?? 90)}° change of direction` });
    }
    if (i > 0 && isCleanoutPart(elements, p.via)) sinceMm = 0;
    let at = spacingFt * FT - sinceMm;
    while (at < total) {
      raw.push({ piece: p, fromHeadMm: at, spot: "spacing", reason: `${spacingFt} ft along the drain since the last cleanout` });
      at += spacingFt * FT;
    }
    sinceMm = (sinceMm + total) % (spacingFt * FT);
  });
  const last = line[line.length - 1];
  if (last) {
    const tailEnd = last.reversed ? "start" : "end";
    const link = last.seg.links[tailEnd];
    if (link && sewerConnectionOf(elements, link.elementId)) raw.push({ piece: last, fromHeadMm: (lengths[line.length - 1] ?? 0) - CLEAR_MM, spot: "sewer_connection", reason: "where the drain meets the sewer connection" });
  }

  const ghosts: CleanoutGhost[] = [];
  const existing = existingCleanouts(elements, line);
  for (const r of raw) {
    const seg = r.piece.seg;
    const total = len3(sub3(seg.end, seg.start));
    const type = cleanoutInlineType(nominalInOf(seg.size));
    if (!type) {
      notes.push("The starter in-line cleanout isn't in this model's add-ons");
      break;
    }
    const half = halfLength(type.definition);
    const min = model.settings.minStraightMm;
    const cut = straightPiece(elements, seg);
    const headRoom = Math.max(min, r.piece.reversed ? cut.cutEnd : cut.cutStart);
    const tailRoom = Math.max(min, r.piece.reversed ? cut.cutStart : cut.cutEnd);
    const lo = headRoom + half + 1;
    const hi = total - tailRoom - half - 1;
    // Clamp the spot onto the piece so the cleanout fits between its ends.
    const wanted = r.fromHeadMm + (r.spot === "upper_end" ? half : r.spot === "spacing" ? 0 : -half);
    const fromHead = hi < lo ? Math.min(Math.max(wanted, 0), total) : Math.min(Math.max(wanted, lo), hi);
    const atMm = Math.round((r.piece.reversed ? total - fromHead : fromHead) * 1000) / 1000;
    const point = add3(seg.start, scale3(segmentAxis(seg), atMm));
    if (existing.some((e) => len3(sub3(e.point, point)) < NEAR_EXISTING_MM)) continue;
    if (hi < lo) {
      notes.push(`The ${feet(total)} ${name(r.piece)} is too short for a cleanout at ${r.reason}; put one on the pipe beside it`);
      continue;
    }
    if (ghosts.some((g) => g.segmentId === seg.id && Math.abs(g.atMm - atMm) < 2 * half + 2 * min)) continue;
    const u = segmentAxis(seg);
    ghosts.push({
      key: `${seg.id}#${ghosts.length + 1}`,
      roomId: seg.id,
      segmentId: seg.id,
      atMm,
      spot: r.spot,
      typeId: type.typeId,
      partType: type.definition,
      levelId: seg.levelId,
      position: { x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 },
      heightMm: Math.round(point.z * 1000) / 1000,
      rotationDeg: Math.round((Math.atan2(u.y, u.x) * 180) / Math.PI * 1000) / 1000,
      reason: r.reason,
    });
  }
  const total = ghosts.length;
  const worded = ghosts.map((g, i) => ({ ...g, reason: `Cleanout ${i + 1} of ${total}: ${g.reason}` }));
  return {
    ghosts: worded,
    summary: total === 0 ? `No cleanout to add on this drain (${line.length} piece${line.length === 1 ? "" : "s"})` : `${total} cleanout${total === 1 ? "" : "s"} proposed on this drain`,
    passes: total === 0,
    notes,
  };
}

function halfLength(def: PartTypeDefinition): number {
  const w = def.typeValues.width;
  return typeof w === "number" ? w / 2 : 4 * IN;
}

function existingCleanouts(elements: Elements, line: readonly Piece[]): Array<{ point: { x: number; y: number; z: number } }> {
  const out: Array<{ point: { x: number; y: number; z: number } }> = [];
  for (const p of line) {
    for (const end of ["start", "end"] as const) {
      const link = p.seg.links[end];
      const el = link ? elements[link.elementId] : undefined;
      if (!isCleanoutPart(elements, el)) continue;
      out.push({ point: p.seg[end] });
    }
  }
  return out;
}

/**
 * Approve: the kept ghosts put on their pipes in one edit (one undo step).
 * Cleanouts on the same pipe go in from its far end back, so each cut lands
 * on the piece that still holds its spot. Returns why not, in words.
 */
export function acceptCleanoutsCommand(model: ModelState, ghosts: readonly CleanoutGhost[], options: { readonly idPrefix?: string } = {}): Command | string {
  if (ghosts.length === 0) return "Nothing to place: no proposed cleanout was kept.";
  const ordered = [...ghosts].sort((a, b) => (a.segmentId === b.segmentId ? b.atMm - a.atMm : a.segmentId.localeCompare(b.segmentId)));
  const steps: EditBatchCommand["commands"] = [];
  const prefix = options.idPrefix ?? "co";
  // Each cleanout is planned on the pipe as the ones before it left it (a cut moves the next spot's piece).
  let working = model;
  for (const g of ordered) {
    const pinned = working.elements[g.typeId]?.kind === "part_type";
    const plan = insertPartOnRun(working, { runId: g.segmentId, atMm: g.atMm, partDefinitionId: g.typeId, ...(pinned ? {} : { partType: g.partType }), idPrefix: `${prefix}-${g.segmentId}-${Math.round(g.atMm)}` });
    if (isPackRefusal(plan)) return plan.refused;
    for (const c of plan) {
      const run = executeCommand(working, c);
      if (!run.ok) return run.error.message;
      working = run.model;
      if (c.type === "batch_edits") steps.push(...c.commands);
    }
  }
  return { type: "batch_edits", label: `Place ${ghosts.length} cleanout${ghosts.length === 1 ? "" : "s"} on the drain`, commands: steps };
}

/** Why Propose cleanouts can't run on this selection, in words; null when it is on a level drain. */
export function cleanoutProposalBlocked(model: Pick<ModelState, "elements">, selectedIds: readonly string[]): string | null {
  return drainLine(model.elements, selectedIds).length > 0 ? null : CLEANOUT_PROPOSAL_WORDS.selectDrain;
}

/** Plumbing's cleanout proposer on the generic proposer point; Approve goes through `acceptCleanoutsCommand`, not the generic device placement. */
export const CLEANOUT_PROPOSER: ProposerDef = {
  id: CLEANOUT_PROPOSER_ID,
  label: "Cleanouts",
  hosts: "drain pipes",
  propose: (model, request) => proposeCleanouts(model, request),
  acceptAt: () => null,
};
