/**
 * @jest-environment node
 *
 * r7: receptacles through the generic proposer point.
 *
 * - r7-receptacle-equivalence: the Electrical add-on's row at
 *   `kernel.proposer` gives exactly the devices the Electrical tab's
 *   proposal always gave (keys, positions, heights, rotations, reasons).
 * - r7-apply-similar: "do the same in the similar rooms" over ten copies of
 *   Unit 001 is one undoable edit, every unit getting the same receptacles.
 *
 * Fails on the code before step 7b: there is no proposer point.
 */
import { performance } from "node:perf_hooks";
import { acceptGhostsCommand, asRevision, builtinPartTypes, DEFAULT_SETTINGS, executeCommand, runProposer, similarRooms, unit001Architecture, withUpgradePolicy, type Command, type GhostPlacement, type ModelState } from "@permitzip/bim-kernel";
import { bindModelPacks, isPackRefusal, PackSet, withModelPacks } from "@permitzip/bim-kernel/packs";
import { necEdition, receptaclePlacementRules } from "@permitzip/bim-calc";
import { ELECTRICAL_PACK, proposeReceptacles, receptacleRoomGeometries, RECEPTACLE_PROPOSER_ID } from "@permitzip/bim-pack-electrical";

const ID = "r7-receptacles";
const UNIT_ROOMS = ["living", "kitchen", "entry", "hall", "bed", "bath", "closet", "laundry"];

function run(model: ModelState, command: Command): ModelState {
  const r = withUpgradePolicy(() => true, () => executeCommand(model, command));
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

function starter(id: string) {
  const t = builtinPartTypes().find((x) => x.id === id);
  if (!t) throw new Error(`starter type ${id} missing`);
  return t;
}
const duplex = starter("builtin:duplex-receptacle@1");
const counterType = starter("builtin:countertop-receptacle@1");
const gfci = starter("builtin:gfci-receptacle@1");
const OPTIONS = { mode: "dwelling", edition: "2023", countertopTypeId: counterType.id, bathroomTypeId: gfci.id };

/** `units` copies of Unit 001 side by side, 30 ft apart. */
function building(units: number): ModelState {
  let m: ModelState = { modelId: ID, revision: asRevision(0), elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  for (let u = 0; u < units; u += 1) m = run(m, unit001Architecture("lvl-1", `u${u}`, { x: u * 30, y: 0 }));
  return m;
}

beforeAll(() => bindModelPacks(ID, PackSet.create([ELECTRICAL_PACK])));

function ghosts(model: ModelState, roomIds: readonly string[]): readonly GhostPlacement[] {
  const answer = runProposer(model, RECEPTACLE_PROPOSER_ID, { typeId: duplex.id, roomIds, options: OPTIONS });
  if (isPackRefusal(answer)) throw new Error(answer.refused);
  return answer.ghosts;
}

describe("r7-receptacle-equivalence", () => {
  it("the proposer row gives exactly the Electrical tab's devices", () => {
    const model = building(1);
    const roomIds = UNIT_ROOMS.map((r) => `u0-${r}`);
    const rules = receptaclePlacementRules(necEdition("2023"));
    const old = proposeReceptacles(receptacleRoomGeometries(model, roomIds, rules), { mode: "dwelling", rules, devices: { wall: duplex.id, countertop: counterType.id, bathroom: gfci.id } });
    const now = ghosts(model, roomIds);
    expect(now.map((g) => [g.key, g.roomId, g.typeId, g.position, g.heightMm, g.rotationDeg, g.reason, g.cite])).toEqual(old.devices.map((d) => [d.key, d.roomId, d.typeId, d.position, d.heightMm, d.rotationDeg, d.reason, d.cite]));
    expect(now.length).toBeGreaterThan(0);
  });

  it("asks for an edition in plain words when none is given", () => {
    const answer = runProposer(building(1), RECEPTACLE_PROPOSER_ID, { typeId: duplex.id, roomIds: ["u0-bed"], options: { mode: "dwelling" } });
    expect(answer).toEqual({ refused: "Pick the NEC edition first." });
  });
});

describe("r7-apply-similar", () => {
  it("one unit's receptacles, done the same in the nine similar units, is one edit", () => {
    const model = building(10);
    const unit0 = UNIT_ROOMS.map((r) => `u0-${r}`);
    expect(similarRooms(model.elements, "u0-kitchen")).toEqual(["u1-kitchen", "u2-kitchen", "u3-kitchen", "u4-kitchen", "u5-kitchen", "u6-kitchen", "u7-kitchen", "u8-kitchen", "u9-kitchen"]);
    const all = [...unit0, ...unit0.flatMap((id) => similarRooms(model.elements, id))];
    const t0 = performance.now();
    const proposed = ghosts(model, all);
    const command = withModelPacks(ID, () => acceptGhostsCommand(model, proposed, { label: "Receptacles in 10 units", fallbackLevelId: "lvl-1" }));
    if (typeof command === "string") throw new Error(command);
    const after = run(model, command);
    const ms = performance.now() - t0;
    const perUnit = ghosts(model, unit0).length;
    expect(proposed).toHaveLength(perUnit * 10);
    expect(perUnit * 10).toBeGreaterThanOrEqual(160);
    // One command placed every ghost: one approval, one undo.
    expect(command.devices).toHaveLength(proposed.length);
    const placed = Object.values(after.elements).filter((e) => e.kind === "part" && !model.elements[e.id]);
    expect(placed).toHaveLength(proposed.length);
    process.stderr.write(`[r7 propose.apply_similar] ${proposed.length} receptacles in 10 units, one edit: ${ms.toFixed(1)} ms\n`);
  });
});
