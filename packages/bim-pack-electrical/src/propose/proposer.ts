import { densityReceptacleRules, NEC_EDITIONS, receptaclePlacementRules, resolveNecEdition, type NecEditionYear } from "@permitzip/bim-calc";
import type { GhostPlacement, ModelState, ProposerAnswer, ProposerDef, ProposerRequest, RoomGeometry } from "@permitzip/bim-kernel";
import { receptacleRoomGeometries } from "./accept";
import { DENSITY_PRESETS, type DensityPreset, type ReceptacleProposal } from "./types";
import { proposeReceptacles, wallMountsFor, type ReceptacleRequest } from "./receptacles";

/**
 * The Electrical add-on's row at `kernel.proposer`: receptacles by NEC 210.52
 * wall spacing (dwelling) or a firm density preset, the same proposal the
 * Electrical tab's Propose receptacles has always made, as ghosts. The
 * engineer picks the device type; nothing is circuited.
 */

export const RECEPTACLE_PROPOSER_ID = "electrical.receptacles";

/** What the receptacle proposer reads from `ProposerRequest.options`. */
export interface ReceptacleProposerOptions {
  readonly mode: "dwelling" | "density";
  readonly edition?: NecEditionYear;
  readonly preset?: DensityPreset;
  readonly countertopTypeId?: string;
  readonly bathroomTypeId?: string;
}

function readOptions(raw: ProposerRequest["options"]): ReceptacleProposerOptions | string {
  const o = raw ?? {};
  const mode = o.mode === "density" ? "density" : o.mode === undefined || o.mode === "dwelling" ? "dwelling" : null;
  if (!mode) return `Receptacles are proposed by dwelling spacing or by density, not "${String(o.mode)}".`;
  const edition = typeof o.edition === "string" ? NEC_EDITIONS.find((e) => e === o.edition) : undefined;
  if (o.edition !== undefined && !edition) return `NEC ${String(o.edition)} isn't an edition this release has (${NEC_EDITIONS.join(", ")}).`;
  const preset = typeof o.preset === "string" ? DENSITY_PRESETS.find((p) => p === o.preset) : undefined;
  if (o.preset !== undefined && !preset) return `Density is light, medium or heavy, not "${String(o.preset)}".`;
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const countertopTypeId = text(o.countertopTypeId);
  const bathroomTypeId = text(o.bathroomTypeId);
  return { mode, ...(edition ? { edition } : {}), ...(preset ? { preset } : {}), ...(countertopTypeId ? { countertopTypeId } : {}), ...(bathroomTypeId ? { bathroomTypeId } : {}) };
}

/** The receptacle request the Electrical tab builds, from the generic request. */
export function receptacleRequestFor(model: ModelState, request: ProposerRequest): ReceptacleRequest | string {
  const o = readOptions(request.options);
  if (typeof o === "string") return o;
  let rules: ReceptacleRequest["rules"];
  if (o.mode === "density") {
    if (!o.preset) return "Choose light, medium or heavy density.";
    rules = densityReceptacleRules();
  } else {
    if (!o.edition) return "Pick the NEC edition first.";
    const nec = resolveNecEdition({ necEdition: o.edition });
    if (!nec.ok) return nec.reason;
    rules = receptaclePlacementRules(nec.edition);
  }
  const devices = { wall: request.typeId, ...(o.countertopTypeId ? { countertop: o.countertopTypeId } : {}), ...(o.bathroomTypeId ? { bathroom: o.bathroomTypeId } : {}) };
  return { mode: o.mode, ...(o.preset ? { preset: o.preset } : {}), rules, devices, mounts: wallMountsFor(model, [devices.wall, devices.countertop, devices.bathroom]) };
}

/** The rooms as the proposer reads them and the proposal along them, in one call (the agent tool shows both). */
export function proposeReceptaclesInRooms(model: Pick<ModelState, "elements" | "connections">, roomIds: readonly string[], request: ReceptacleRequest): { proposal: ReceptacleProposal; rooms: RoomGeometry[] } {
  const rooms = receptacleRoomGeometries(model, roomIds, request.rules);
  return { proposal: proposeReceptacles(rooms, request), rooms };
}

/** A receptacle proposal's devices as ghosts, one for one (same keys, positions, heights and reasons). */
export function ghostsOfReceptacleProposal(proposal: ReceptacleProposal): GhostPlacement[] {
  return proposal.devices.map((d) => ({ key: d.key, roomId: d.roomId, typeId: d.typeId, position: d.position, heightMm: d.heightMm, rotationDeg: d.rotationDeg, reason: d.reason, cite: d.cite }));
}

export const RECEPTACLE_PROPOSER: ProposerDef = {
  id: RECEPTACLE_PROPOSER_ID,
  label: "Receptacles",
  hosts: "walls and countertops",
  propose(model: ModelState, request: ProposerRequest): ProposerAnswer | { readonly refused: string } {
    const req = receptacleRequestFor(model, request);
    if (typeof req === "string") return { refused: req };
    const geometry = receptacleRoomGeometries(model, [...request.roomIds], req.rules);
    if (geometry.length === 0) return { refused: "None of these rooms has an outline to propose along." };
    const proposal = proposeReceptacles(geometry, req);
    return { ghosts: ghostsOfReceptacleProposal(proposal), summary: proposal.summary, passes: proposal.passes, notes: proposal.rooms.flatMap((r) => r.notes) };
  },
};
