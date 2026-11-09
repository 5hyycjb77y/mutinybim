import { builtinPartType } from "../library/builtin";
import { defineExtensionPoint } from "../packs/contract";
import type { PackRefusal } from "../packs/points";
import { activePackSet, withModelStatePacks } from "../packs/scope";
import type { PartTypeDefinition } from "../parts";
import { spaceOutlines } from "../spaces/space-geometry";
import { elementsOfKind } from "../store";
import type { ModelState, Vec2 } from "../types";
import { MAX_PLACE_DEVICES, type ProposeCommand } from "./commands";
import { pointInOutline } from "./perimeter";

/**
 * Proposers (contract 1.4.0, `kernel.proposer` v1): a proposer reads what
 * the requirements graph asks of a place (spacing, coverage, count) and the
 * surface or room it would host on, and returns GHOST placements, each naming
 * the requirement it fulfils and why, in plain words. It never connects
 * anything: the engineer picks the device type, a person accepts
 * the ghosts as one edit (`acceptGhostsCommand`), and connecting them stays a
 * separate decision.
 *
 * Any trade's add-on contributes one: devices by wall spacing, devices by
 * ceiling coverage, heads by hazard spacing, terminals by the flow a room needs.
 */

/** One proposed device, not yet in the model. */
export interface GhostPlacement {
  /** Stable within one answer (`<roomId>#<n>`), so a person can drop some. */
  readonly key: string;
  /** The room or space it is proposed for. */
  readonly roomId: string;
  /** What it stands on, when not the floor: a ceiling id, a wall id. */
  readonly hostId?: string;
  /** The part type the engineer chose. */
  readonly typeId: string;
  readonly position: Vec2;
  /** Its level; absent: the room's level. */
  readonly levelId?: string;
  /** Height above the level, mm. */
  readonly heightMm: number;
  /** Counter-clockwise from east, degrees. */
  readonly rotationDeg: number;
  /** The requirement it fulfils (a requirements-graph id), when the graph has one. */
  readonly requirementId?: string;
  /** Plain words: "Detector 1 of 4: the ceiling's 39 m² at one per 20 m²". */
  readonly reason: string;
  /** The citation in the author's words ("Test Alarm Code T-1.1"). */
  readonly cite?: string;
}

export interface ProposerRequest {
  /** The part type the engineer picked. */
  readonly typeId: string;
  /** The rooms or spaces to propose for. */
  readonly roomIds: readonly string[];
  /** The proposer's own options (an edition, a density preset). */
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ProposerAnswer {
  readonly ghosts: readonly GhostPlacement[];
  /** "4 detectors in Room 104; every point within 6.4 m: passes". */
  readonly summary: string;
  readonly passes: boolean;
  readonly notes: readonly string[];
}

export interface ProposerDef {
  /** `<pack>.<name>` ("fa.smoke_detectors"). */
  readonly id: string;
  readonly label: string;
  /** What it hosts on, in words ("walls", "typed ceilings"). */
  readonly hosts: string;
  propose(model: ModelState, request: ProposerRequest): ProposerAnswer | PackRefusal;
  /**
   * Optional (contract 1.5.0): the ghosts a plan click at `point` accepts, or
   * null when the click isn't on anything previewed (the host then selects as
   * before). Absent: the ghosts of the previewed room whose outline holds the
   * point (`ghostsAt`).
   */
  acceptAt?(model: ModelState, answer: ProposerAnswer, point: Vec2): readonly GhostPlacement[] | null;
}

export const PROPOSER_POINT = defineExtensionPoint<ProposerDef>({
  id: "kernel.proposer",
  version: 1,
  label: "Proposers",
  idOf: (p) => p.id,
});

/** The proposers the model's add-ons contribute. */
export function proposersFor(model: ModelState): readonly ProposerDef[] {
  return withModelStatePacks(model, () => activePackSet().items(PROPOSER_POINT));
}

/** Run one proposer inside the model's add-on set. A missing proposer, or one that throws, is a refusal in plain words (logged). */
export function runProposer(model: ModelState, proposerId: string, request: ProposerRequest): ProposerAnswer | PackRefusal {
  return withModelStatePacks(model, () => {
    const proposer = activePackSet().items(PROPOSER_POINT).find((p) => p.id === proposerId);
    if (!proposer) return { refused: `Nothing on this model proposes "${proposerId}". Its add-on isn't loaded here.` };
    try {
      return proposer.propose(model, request);
    } catch (err) {
      console.error(`[bim-kernel/propose] proposer ${proposerId} failed`, err);
      return { refused: `${proposer.label} couldn't propose: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}


/**
 * The one edit that accepts ghosts: every ghost kept, on its level, each
 * part type pinned from the starter library when the model lacks it. One
 * approval, one revision, one undo; nothing is connected. Returns why not, in
 * words, when it can't be built.
 */
export function acceptGhostsCommand(model: Pick<ModelState, "elements">, ghosts: readonly GhostPlacement[], options: { readonly label: string; readonly fallbackLevelId?: string; readonly partIdPrefix?: string }): ProposeCommand | string {
  if (ghosts.length === 0) return "Nothing to place: no proposed device was kept.";
  if (ghosts.length > MAX_PLACE_DEVICES) return `${ghosts.length} devices is more than one edit takes (${MAX_PLACE_DEVICES}); accept fewer rooms at a time.`;
  const levelOf = (g: GhostPlacement): string | null => {
    if (g.levelId) return g.levelId;
    const name = model.elements[g.roomId]?.partition?.level;
    const byName = name ? elementsOfKind(model.elements, "level").find((l) => l.name === name)?.id : undefined;
    const spaceLevel = model.elements[g.roomId];
    const own = spaceLevel && "levelId" in spaceLevel && typeof spaceLevel.levelId === "string" ? spaceLevel.levelId : undefined;
    return byName ?? own ?? options.fallbackLevelId ?? null;
  };
  const levels = new Set(ghosts.map(levelOf));
  if (levels.has(null)) return "Choose the level to place them on.";
  if (levels.size > 1) return `These rooms are on ${levels.size} levels; accept one level at a time.`;
  const levelId = [...levels][0] ?? null;
  if (!levelId) return "Choose the level to place them on.";
  const partTypes: Array<{ typeId: string; definition: PartTypeDefinition }> = [];
  for (const typeId of new Set(ghosts.map((g) => g.typeId))) {
    if (model.elements[typeId]?.kind === "part_type") continue;
    const builtin = builtinPartType(typeId);
    if (!builtin) return `Part type ${typeId} isn't in this model or the starter library.`;
    partTypes.push({ typeId, definition: builtin.definition });
  }
  const prefix = options.partIdPrefix ?? "ghost";
  return {
    type: "place_devices",
    label: options.label.slice(0, 160),
    levelId,
    ...(partTypes.length > 0 ? { partTypes } : {}),
    devices: ghosts.map((g) => {
      const zone = model.elements[g.roomId]?.partition?.zone;
      return {
        partId: `${prefix}-${g.roomId}-${Math.round(g.position.x)}-${Math.round(g.position.y)}`.slice(0, 200),
        typeId: g.typeId,
        position: g.position,
        rotationDeg: g.rotationDeg,
        offsetMm: g.heightMm,
        ...(zone ? { zone } : {}),
      };
    }),
  };
}

/** The floor outlines of a previewed room or space (a space's own outline, or the rooms it follows). */
function outlinesOf(model: Pick<ModelState, "elements">, id: string): ReadonlyArray<readonly Vec2[]> {
  const el = model.elements[id];
  if (el?.kind === "room") return [el.outline];
  if (el?.kind === "space") return spaceOutlines(model.elements, el);
  return [];
}

/** The previewed rooms' ghosts at a point: the ghosts of the room or space whose outline holds it, or null when the point is on none of them. */
function ghostsOfRoomAt(model: Pick<ModelState, "elements">, answer: ProposerAnswer, point: Vec2): readonly GhostPlacement[] | null {
  const roomIds = [...new Set(answer.ghosts.map((g) => g.roomId))];
  for (const roomId of roomIds) {
    if (outlinesOf(model, roomId).some((o) => o.length >= 3 && pointInOutline(point, o))) return answer.ghosts.filter((g) => g.roomId === roomId);
  }
  return null;
}

/**
 * What a plan click at `point` accepts while a proposal previews: the
 * proposer's own `acceptAt` when it has one, else the ghosts of the previewed
 * room under the point. Null: the click is elsewhere and selects as before.
 * Reads only the previewed rooms' outlines.
 */
export function ghostsAt(model: ModelState, proposerId: string, answer: ProposerAnswer, point: Vec2): readonly GhostPlacement[] | null {
  return withModelStatePacks(model, () => {
    const proposer = activePackSet().items(PROPOSER_POINT).find((p) => p.id === proposerId);
    if (proposer?.acceptAt) {
      try {
        return proposer.acceptAt(model, answer, point);
      } catch (err) {
        console.error(`[bim-kernel/propose] proposer ${proposerId} acceptAt failed; using the room under the click`, err);
      }
    }
    return ghostsOfRoomAt(model, answer, point);
  });
}
