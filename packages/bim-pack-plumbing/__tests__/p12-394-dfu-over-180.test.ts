/**
 * @jest-environment node
 *
 * Owed from round 12 (P12, the Oct 26 review): a drawn 4 in drain at 1/8 in/ft
 * carrying 394 drainage units against a firm capacity table that allows 180
 * at that size and slope is named on the pipe itself, by the drawn-drain
 * check (`drainOverDrainageUnits`) and its Checklist rule
 * `drain-over-drainage-units`. With no table row it is not judged; a table
 * that allows the load says nothing.
 *
 * Fails on round 11's code: the drawn drain was never read against the
 * firm's table (`drainOverDrainageUnits` and the rule didn't exist).
 */
import { DEFAULT_SETTINGS, asElementId, builtinPartType, planCommit, type Command, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK, drainOverDrainageUnits } from "../src";

const MAIN = asElementId("main-s1");
const FT = 304.8;
const IN = 25.4;
let n = 0;

function commit(model: ModelState, command: Command): ModelState {
  const d = planCommit(model, [], { idempotencyKey: `p12-394-${++n}-key`, baseRevision: model.revision, actor: { id: "priya", name: "Priya", kind: "human" }, command }, () => "2026-11-04T00:00:00.000Z");
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

/** A 4 in building drain below the slab, falling at the sanitary minimum, with a fixture group of 394 drainage units on it. */
function drain(capacityTable?: readonly { nominalIn: number; inPerFt?: number; maxDfu: number }[]): ModelState {
  const wc = builtinPartType("builtin:water-closet-floor@1");
  if (!wc) throw new Error("starter library");
  const group = { ...wc.definition, typeName: "Fixture group (394 DFU)", typeValues: { ...wc.definition.typeValues, fixture_units: 394 } };
  let m: ModelState = { modelId: "p12-394", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = commit(m, { type: "place_part", partId: "grp", typeId: "type-grp", partType: group, levelId: "lvl-1", position: { x: 0, y: 10 * FT }, offsetMm: 0, mark: "GRP-1" });
  m = commit(m, { type: "route_run", idPrefix: "main", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 4 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "sys-san", kind: "sanitary", name: "Sanitary" }, points: [{ x: -10 * FT, y: 8 * FT }, { x: 10 * FT, y: 8 * FT }] });
  m = commit(m, { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 4 * IN, material: "pvc" }, elevationMm: -2 * FT, system: { id: "sys-san", kind: "sanitary", name: "Sanitary" }, points: [{ x: -150, y: 10 * FT }, { x: -150, y: 8 * FT }], from: { kind: "part", partId: "grp", connectorId: "waste" }, to: { kind: "run_branch", segmentId: "main-s1" } });
  if (capacityTable) m = commit(m, { type: "set_system_design", systemId: "sys-san", design: { pipe: { capacityTable: [...capacityTable] } } });
  return m;
}

describe("p12-394-dfu-over-180", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("394 DFU on a drawn 4 in drain at 1/8 in/ft is over the firm's 180", () => {
    const m = drain([{ nominalIn: 4, inPerFt: 0.125, maxDfu: 180 }]);
    expect(drainOverDrainageUnits(m.elements, MAIN)).toEqual({ elementId: "main-s1", dfu: 394, maxDfu: 180, nominalIn: 4, slopeInPerFt: 0.125, slopeText: '1/8"' });
  });

  it("a table that allows it, or no table row at all, says nothing", () => {
    expect(drainOverDrainageUnits(drain([{ nominalIn: 4, inPerFt: 0.125, maxDfu: 400 }]).elements, MAIN)).toBeNull();
    expect(drainOverDrainageUnits(drain().elements, MAIN)).toBeNull();
    expect(drainOverDrainageUnits(drain([{ nominalIn: 6, inPerFt: 0.125, maxDfu: 700 }]).elements, MAIN)).toBeNull();
  });
});
