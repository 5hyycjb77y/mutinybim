import { z } from "zod";
import { densityReceptacleRules, receptaclePlacementRules, type resolveNecEdition } from "@permitzip/bim-calc";
import { elementsOfKind, similarRooms, type ModelState, type RoomGeometry } from "@permitzip/bim-kernel";
import { PROPOSE_ARGS } from "../agent-tools";
import { receptacleRoomGeometries } from "./accept";
import { proposeReceptacles, wallMountsFor, type ReceptacleRequest } from "./receptacles";
import type { ReceptacleProposal, ReceptacleRules } from "./types";
import { ROOM_RULES } from "./types";

/**
 * The agent's proposal (bim_propose_receptacles / bim_accept_receptacles):
 * the rooms named or like them, the code or density rules, the device types
 * the person picked. Moved here from the host's tool file in round 10, so the
 * host only registers the tool and the trade's logic and words stay in the
 * add-on.
 */
export type ProposeArgs = z.infer<z.ZodObject<typeof PROPOSE_ARGS>>;

function findRoom(model: ModelState, key: string): string | null {
  const direct = model.elements[key];
  if (direct?.kind === "room") return direct.id;
  const k = key.trim().toLowerCase();
  return elementsOfKind(model.elements, "room").find((r) => r.number.trim().toLowerCase() === k)?.id ?? null;
}

/** The proposal for these arguments against this model, or why not. Accept re-runs it, so what is approved is what was previewed at that revision. */
export function buildProposal(model: ModelState, args: ProposeArgs, nec: ReturnType<typeof resolveNecEdition> | null): { proposal: ReceptacleProposal; rooms: RoomGeometry[] } | string {
  let rules: ReceptacleRules;
  if (args.mode === "density") rules = densityReceptacleRules();
  else if (!nec) return "Say which NEC edition applies: dwelling spacing is NEC 210.52. Give nec_edition, or record the project's adopted code.";
  else if (!nec.ok) return `${nec.reason} Give nec_edition, or record the project's adopted code.`;
  else rules = receptaclePlacementRules(nec.edition);
  const ids: string[] = [];
  const roomRules: Record<string, (typeof ROOM_RULES)[number]> = {};
  for (const key of args.rooms) {
    const id = findRoom(model, key);
    if (!id) return `No room "${key}" (bim_query_elements kind room lists them; trace rooms with bim_trace_rooms).`;
    ids.push(id);
  }
  if (args.apply_to_similar) {
    for (const id of [...ids]) for (const like of similarRooms(model.elements, id)) if (model.elements[like]?.kind === "room" && !ids.includes(like)) ids.push(like);
  }
  const rooms: RoomGeometry[] = receptacleRoomGeometries(model, ids, rules);
  for (const [key, rule] of Object.entries(args.room_rules ?? {})) {
    const id = findRoom(model, key);
    if (!id) return `room_rules names "${key}", which isn't a room.`;
    roomRules[id] = rule;
  }
  if (args.mode === "density" && !args.preset) return "Ask the person which density they want: light, medium or heavy.";
  const request: ReceptacleRequest = {
    mode: args.mode,
    ...(args.preset ? { preset: args.preset } : {}),
    rules,
    devices: { wall: args.wall_type, ...(args.countertop_type ? { countertop: args.countertop_type } : {}), ...(args.bathroom_type ? { bathroom: args.bathroom_type } : {}) },
    roomRules,
    mounts: wallMountsFor(model, [args.wall_type, args.countertop_type, args.bathroom_type]),
  };
  return { proposal: proposeReceptacles(rooms, request), rooms };
}
