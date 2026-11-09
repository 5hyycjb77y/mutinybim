import type { Command, EditBatchCommand } from "../commands";
import type { PackRefusal } from "../packs/points";
import { resolveConnectors, type PartTypeDefinition, type ResolvedConnector } from "../parts";
import type { ElementId, ModelState } from "../types";
import { straightPiece } from "./fittings/geometry";
import { add3, connectorAccepts, dot3, len3, p3, round3, scale3, segmentAxis, sub3 } from "./geometry";
import { sizeLabel } from "./rules";
import { runLabel } from "./run-label";
import { branchClearance } from "./validate";
import type { RunPoint, RunSegment } from "./types";

/**
 * Insert a part on a run (contract 1.12.0): split a run at a point and put a
 * part's two in-line connectors there, the same for a cleanout on a drain, a
 * valve on a water line or a damper in an air run. Proposals that place a part
 * inline (ghost → Approve) land through it. Peers that keep the split
 * advertise the feature; a host offers Approve only when every peer does.
 */
export const ROUTING_INSERT_PART_FEATURE = "routing:insert_part";

export interface InsertPartOnRun {
  /** The run the part goes on. */
  readonly runId: ElementId;
  /** Distance along the run from its start (model mm): where the part's middle goes. */
  readonly atMm: number;
  /** The part definition to place (a catalog or firm library part id). */
  readonly partDefinitionId: string;
  /** The definition, when the model does not have this type yet (pinned into the model with the part). */
  readonly partType?: PartTypeDefinition;
  /** New ids start with this (a retried request places the same part). Default: the run's id plus "-ins". */
  readonly idPrefix?: string;
  /** Turn the part end for end (its first in-line connector faces the run's end instead of its start). */
  readonly flip?: boolean;
  readonly mark?: string;
}

const MM_PER_FT = 304.8;
const feet = (mm: number) => `${Math.round((mm / MM_PER_FT) * 100) / 100} ft`;
const v3 = (t: readonly [number, number, number]): RunPoint => p3(t[0], t[1], t[2]);
const unit = (a: RunPoint): RunPoint => {
  const l = len3(a);
  return l === 0 ? a : scale3(a, 1 / l);
};

/** Connector pairs that face away from each other along the line between them. */
function inlinePairs(connectors: readonly ResolvedConnector[], domain: string): Array<readonly [ResolvedConnector, ResolvedConnector]> {
  const out: Array<readonly [ResolvedConnector, ResolvedConnector]> = [];
  const own = connectors.filter((c) => c.domain === domain);
  for (let i = 0; i < own.length; i += 1) {
    for (let j = i + 1; j < own.length; j += 1) {
      const a = own[i];
      const b = own[j];
      if (!a || !b) continue;
      const da = unit(v3(a.direction));
      const db = unit(v3(b.direction));
      const across = sub3(v3(b.position), v3(a.position));
      if (len3(across) < 1 || dot3(da, db) > -0.999) continue;
      if (dot3(unit(across), db) < 0.999) continue;
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * The commands that put the part on the run, or the reason it can't go there.
 * One `batch_edits` (one undo step): cut the run where the part's far
 * connector goes, pull the near piece back to the part's near connector, place
 * the part and join both connectors. Sizes, the system and every branch clear
 * of the part are kept; the run's own refusals (a branch at the cut, a piece
 * left too short) still apply when the batch runs.
 */
export function insertPartOnRun(model: ModelState, request: InsertPartOnRun): readonly Command[] | PackRefusal {
  const seg = model.elements[request.runId];
  if (seg?.kind !== "run_segment") return { refused: seg ? `That isn't a straight run; pick the straight piece the part goes on` : `There is no run ${request.runId} in the model` };
  const name = runLabel(model.elements, seg);
  const inModel = model.elements[request.partDefinitionId];
  const definition = inModel?.kind === "part_type" ? inModel.definition : request.partType;
  if (!definition) return { refused: `There is no part type ${request.partDefinitionId} in the model or the request` };
  const pairs = inlinePairs(resolveConnectors(definition), seg.domain);
  const partName = `${definition.familyName} ${definition.typeName}`.trim();
  if (pairs.length === 0) return { refused: `The ${partName} has no pair of connectors a run passes straight through, so it can't go on the ${name}` };
  const fitting = pairs.find(([a, b]) => connectorAccepts(a, seg.size) && connectorAccepts(b, seg.size));
  if (!fitting) return { refused: `The ${partName} doesn't take a ${sizeLabel(seg.size)} run; pick a ${sizeLabel(seg.size)} type` };
  const placed = placement(seg, fitting, request.flip === true);
  if ("refused" in placed) return { refused: `${placed.refused}, so the ${partName} can't go on the ${name}` };

  const total = len3(sub3(seg.end, seg.start));
  const at = request.atMm;
  if (!(at > 0 && at < total)) return { refused: `${feet(at)} isn't on the ${name}, which is ${feet(total)} long` };
  const half = placed.lengthMm / 2;
  const from = at - half;
  const to = at + half;
  const min = model.settings.minStraightMm;
  // Each piece left keeps the room its far fitting takes (an elbow's body) and the shortest straight piece.
  const piece = straightPiece(model.elements, seg);
  const nearRoom = Math.max(min, piece.cutStart);
  const farRoom = Math.max(min, piece.cutEnd);
  if (from < nearRoom || total - to < farRoom) {
    const edge = from < nearRoom ? `${feet(nearRoom + half)} from its start` : `${feet(farRoom + half)} from its end`;
    return { refused: `The ${name} is too short there: the ${partName} needs ${feet(placed.lengthMm)} and the pipe beside it ${feet(from < nearRoom ? nearRoom : farRoom)}. Move it at least ${edge}` };
  }
  const clear = branchClearance(seg.domain, model.settings).end;
  for (const id of seg.branches) {
    const b = model.elements[id];
    if (b?.kind !== "run_fitting" || !b.host) continue;
    if (b.host.s > from - clear && b.host.s < to + clear) return { refused: `The ${runLabel(model.elements, b)} joins the ${name} at ${feet(b.host.s)}, where the ${partName} goes; pick a spot clear of it` };
  }

  const prefix = request.idPrefix ?? `${seg.id}-ins`;
  const partId = `${prefix}-part`;
  const tailId = `${prefix}-cut-s1`;
  if (model.elements[partId] || model.elements[tailId]) return { refused: `${partId} already exists; choose a new id prefix` };

  const u = segmentAxis(seg);
  const farPoint = round3(add3(seg.start, scale3(u, to)));
  const part = placed.at(farPoint);
  const nearWorld = part.connector(placed.near);
  const pullBack = round3(sub3(nearWorld, add3(seg.start, scale3(u, to))));
  const typeId = request.partDefinitionId;
  const steps: EditBatchCommand["commands"] = [
    { type: "split_run", idPrefix: `${prefix}-cut`, segmentId: seg.id, atMm: Math.round(to * 1000) / 1000 },
    { type: "disconnect_run", elementId: seg.id, port: "end" },
    {
      type: "place_part",
      partId,
      typeId,
      ...(inModel?.kind === "part_type" ? {} : { partType: definition }),
      levelId: seg.levelId,
      position: part.position,
      offsetMm: part.offsetMm,
      rotationDeg: part.rotationDeg,
      ...(seg.partition ? { zone: seg.partition.zone } : {}),
      ...(request.mark ? { mark: request.mark } : {}),
    },
    { type: "drag_run", elementId: seg.id, delta: pullBack, grip: "end" },
    { type: "connect_runs", a: { elementId: seg.id, port: "end" }, b: { elementId: partId, port: placed.near.id } },
    { type: "connect_runs", a: { elementId: partId, port: placed.far.id }, b: { elementId: tailId, port: "start" } },
  ];
  return [{ type: "batch_edits", label: `Put a ${partName} on the ${name} at ${feet(at)}`, commands: steps }];
}

interface Placement {
  readonly near: ResolvedConnector;
  readonly far: ResolvedConnector;
  /** Between the two connectors, along the run. */
  readonly lengthMm: number;
  /** Where the part goes so its far connector sits at `farPoint`. */
  at(farPoint: RunPoint): { readonly position: { x: number; y: number }; readonly offsetMm: number; readonly rotationDeg: number; connector(c: ResolvedConnector): RunPoint };
}

/** Turn the pair so its near connector faces the run's start; a level part on a level run, an upright one on a vertical run. */
function placement(seg: RunSegment, [a, b]: readonly [ResolvedConnector, ResolvedConnector], flip: boolean): Placement | PackRefusal {
  const u = segmentAxis(seg);
  let near = flip ? b : a;
  let far = flip ? a : b;
  const local = unit(sub3(v3(far.position), v3(near.position)));
  const runUpright = Math.abs(u.z) > 0.99;
  const partUpright = Math.abs(local.z) > 0.99;
  if (runUpright !== partUpright) return { refused: runUpright ? "The run is vertical and the part's connectors line up level" : "The run is level and the part's connectors line up vertically" };
  // A level part joins a gently sloped run; past ~2° its connectors no longer face the run's ends.
  if (!runUpright && Math.abs(u.z) > 0.04) return { refused: "The run slopes too steeply for the part's level connectors" };
  let rotationDeg = 0;
  if (runUpright) {
    if (Math.sign(local.z) !== Math.sign(u.z)) [near, far] = [far, near];
  } else {
    rotationDeg = Math.round(((Math.atan2(u.y, u.x) - Math.atan2(local.y, local.x)) * 180) / Math.PI * 1e6) / 1e6;
  }
  const rad = (rotationDeg * Math.PI) / 180;
  const rot = (p: RunPoint): RunPoint => p3(p.x * Math.cos(rad) - p.y * Math.sin(rad), p.x * Math.sin(rad) + p.y * Math.cos(rad), p.z);
  const lengthMm = len3(sub3(v3(far.position), v3(near.position)));
  return {
    near,
    far,
    lengthMm,
    at(farPoint) {
      const f = rot(v3(far.position));
      const position = { x: Math.round((farPoint.x - f.x) * 1000) / 1000, y: Math.round((farPoint.y - f.y) * 1000) / 1000 };
      const offsetMm = Math.round((farPoint.z - f.z) * 1000) / 1000;
      return {
        position,
        offsetMm,
        rotationDeg,
        connector(c) {
          const r = rot(v3(c.position));
          return round3(p3(position.x + r.x, position.y + r.y, offsetMm + r.z));
        },
      };
    },
  };
}
