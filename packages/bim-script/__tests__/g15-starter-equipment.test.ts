/** @jest-environment node */
import { runInNewContext } from "node:vm";
import { MeshCache } from "@permitzip/bim-geometry";
import { DEFAULT_SETTINGS, isPartModel2, partConvexPieces, partMesh, setPartMeshProvider, type ModelState, type PartTypeDefinition, type Revision } from "@permitzip/bim-kernel";
import * as kit from "../src";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";

/**
 * G15 starters: a rooftop unit that looks like one, a gas or electric water
 * heater and a panelboard, each an ordinary script library item built from
 * real solids, with the connections an engineer routes to. Fails on round 14:
 * there were no equipment starters and the kit could only stack boxes.
 */

/** The starter's source as the sealed child evaluates it: only the kit in scope. */
function evaluate(source: string): kit.ScriptDefinition {
  const plain = source.replace(/^import \{([^}]*)\} from "@permitzip\/bim-script";$/m, "const {$1} = __kit;").replace(/^export default /m, "__exports.default = ");
  const slot: { default?: kit.ScriptDefinition } = {};
  runInNewContext(plain, { __kit: kit, __exports: slot, Math, Number, String, JSON });
  if (!slot.default) throw new Error("no default export");
  return slot.default;
}

function head(): ModelState {
  return { modelId: "g15-starters", revision: 1 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

async function run(key: string, values: Record<string, string | number | boolean> = {}): Promise<{ def: PartTypeDefinition; check: kit.OutputCheck }> {
  const item = kit.starterScriptItems().find((i) => i.key === key);
  if (!item) throw new Error(`no starter ${key}`);
  expect(kit.checkScriptSource(item.source)).toEqual([]);
  const definition = evaluate(item.source);
  expect(definition.manifest).toEqual(item.manifest);
  const output = await kit.runScript(definition, { slice: kit.sliceModel(head(), definition.manifest.reads), values: { ...kit.resolveValues(definition.manifest), ...values }, scriptHash: item.contentHash ?? "" });
  if (output.kind !== "part_types") throw new Error("expected part types");
  const check = kit.checkScriptOutput(head(), JSON.parse(JSON.stringify(output)));
  const def = output.types[0]?.definition;
  if (!def) throw new Error("no part");
  expect(check.kind === "part_types" ? check.types.flatMap((t) => t.problems) : []).toEqual([]);
  return { def, check };
}

const kinds = (def: PartTypeDefinition) => (def.model && isPartModel2(def.model) ? new Set(def.model.features.map((f) => f.kind)) : new Set<string>());
const IN = 25.4;

beforeAll(async () => {
  setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
});
afterAll(() => setPartMeshProvider(null));

describe("g15 starter equipment", () => {
  it("the library ships rooftop unit, water heater and electrical panel starters", () => {
    expect(kit.starterScriptItems().map((i) => i.key)).toEqual(expect.arrayContaining(["starter.rooftop_unit", "starter.water_heater", "starter.electrical_panel"]));
  });

  it("rooftop unit: a real casing (curb, sections, doors, louvres, fans, hood), its six connections and data fields, and pictures from its solid", async () => {
    const { def, check } = await run("starter.rooftop_unit");
    expect(check.ok).toBe(true);
    if (check.kind !== "part_types") throw new Error("part types");
    expect(check.types[0]?.notes).toEqual([]);
    expect(Object.keys(check.types[0]?.pictures ?? {}).sort()).toEqual(["front", "plan", "side"]);
    expect(def.source).toEqual({ kind: "script" });
    expect([...kinds(def)]).toEqual(expect.arrayContaining(["extrude", "pattern", "mirror"]));
    expect(def.connectors.map((c) => [c.id, c.domain, c.systemKind])).toEqual([
      ["return", "duct", "return_air"],
      ["supply", "duct", "supply_air"],
      ["outside_air", "duct", "outside_air"],
      ["gas", "pipe", "natural_gas"],
      ["power", "electrical", "power"],
      ["condensate", "pipe", "condensate"],
    ]);
    expect(def.typeValues).toMatchObject({ cooling_tons: 10, supply_airflow: 4000, operating_weight: 1250, voltage: 460, heat: "gas heat", curb_size: "106 x 56 in" });
    expect(def.clearances?.map((c) => c.id)).toEqual(["service", "condenser"]);
    const fine = partMesh(def, {}, "fine");
    const coarse = partMesh(def, {}, "coarse");
    // Curb 14 + rail 4 + casing 44 in, plus the fan guards; the hood stands 14 in off the back.
    expect(fine.bounds.max[2]).toBeCloseTo((14 + 4 + 44 + 3) * IN, 0);
    expect(fine.bounds.min[0]).toBeCloseTo(-55 * IN - 14 * IN, 0);
    // Detail levels: fine has the louvres, fan blades and handles; coarse doesn't.
    expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount * 1.5);
    // The curb is hollow, so clash sees no material where the ducts drop through it.
    const pieces = partConvexPieces(def, {}, "medium").pieces;
    expect(pieces.length).toBeGreaterThan(20);
  }, 60_000);

  it("rooftop unit, electric heat: no gas connection or flue hood", async () => {
    const { def, check } = await run("starter.rooftop_unit", { heat: "electric" });
    expect(check.ok).toBe(true);
    expect(def.connectors.map((c) => c.id)).not.toContain("gas");
  }, 60_000);

  it.each([["gas"], ["electric"]])("water heater (%s): revolved jacket and head, its water, relief, drain and fuel connections", async (fuel) => {
    const { def, check } = await run("starter.water_heater", { fuel });
    expect(check.ok).toBe(true);
    expect([...kinds(def)]).toEqual(expect.arrayContaining(["revolve", "pattern", "mirror"]));
    const ids = def.connectors.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["cold", "hot", "relief", "drain"]));
    expect(ids).toEqual(expect.arrayContaining(fuel === "gas" ? ["gas", "flue"] : ["power"]));
    const m = partMesh(def);
    expect(m.bounds.max[0] - m.bounds.min[0]).toBeGreaterThan(22 * IN);
  }, 60_000);

  it("electrical panel: tub, trim and door; a feeder and branch-circuit connections; its electrical data and a working space", async () => {
    const { def, check } = await run("starter.electrical_panel");
    expect(check.ok).toBe(true);
    expect(def.connectors.map((c) => c.id)).toEqual(["feeder", "branch_a", "branch_b", "branch_c"]);
    expect(def.connectors[0]).toMatchObject({ domain: "electrical", voltage: 208, poles: 3, flowDirection: "in" });
    expect(def.typeValues).toMatchObject({ voltage: 208, phases: "3", circuits: 42, bus_rating: 225 });
    expect(def.instanceParams.map((p) => p.name)).toEqual(["panel_name", "aic", "enclosure"]);
    expect(def.tagFields).toEqual(["panel_name"]);
    expect(def.clearances?.[0]).toMatchObject({ purpose: "working_space", face: "right", fromFloor: true });
    // The trim stands 3/4 in proud of the 78 in top of the tub.
    expect(partMesh(def).bounds.max[2]).toBeCloseTo(78.75 * IN, 0);
  }, 60_000);
});
