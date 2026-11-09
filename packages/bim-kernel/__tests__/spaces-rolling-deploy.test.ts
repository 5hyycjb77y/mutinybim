/**
 * @jest-environment node
 *
 * Rolling deploy: while the new model server is going out, an older client
 * (or an older worker) receives space, zone and drawing-underlay records it
 * has never seen. It must ignore them, never fail: plans draw the same, the
 * model validates the same, schedules of the old categories print the same,
 * and the records survive a JSON round trip untouched so the next client sees
 * them.
 *
 * Fails on the old code path it protects: any reader that switches on
 * `el.kind` with a throwing default (as `connectorPointOf` does for kinds
 * with no network connectors) would throw here, and the plan scene would
 * change if it tried to draw an unknown kind.
 */
import {
  asElementId,
  buildViewScene,
  canonicalJson,
  DEFAULT_SETTINGS,
  executeCommand,
  recomputeDerived,
  validateModel,
  type BimElement,
  type Command,
  type ModelState,
} from "../src";
import { networkOf } from "../src/network";
import { executeSpaceDesignCommand, type SpaceDesignCommand } from "../src/spaces/space-commands";

const L1 = asElementId("L1");

function base(): ModelState {
  const level: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  let model: ModelState = { modelId: "rd", revision: 0 as ModelState["revision"], elements: { [L1]: level }, connections: [], settings: DEFAULT_SETTINGS };
  const run = (c: Command) => {
    const r = executeCommand(model, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
    model = r.model;
  };
  run({ type: "create_view", viewId: "v-plan", name: "Level 1 plan", viewType: "floor_plan", props: { level: "Level 1" } });
  return model;
}

function withSpatialDesign(model: ModelState): ModelState {
  let m = model;
  const run = (c: SpaceDesignCommand) => {
    const r = executeSpaceDesignCommand(m, c);
    if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
    m = r.model;
  };
  run({ type: "place_underlay", underlayId: "u1", levelId: L1, source: { format: "pdf", provider: "host.workspace", ref: "file-1", page: 1, name: "A-101.pdf" } });
  run({ type: "calibrate_underlay", underlayId: "u1", calibration: { method: "stated_scale", scale: `1/8" = 1'-0"` } });
  run({ type: "create_space", spaces: [{ spaceId: "s1", number: "101", name: "Dining", levelId: L1, outline: [{ x: 0, y: 0 }, { x: 9000, y: 0 }, { x: 9000, y: 6000 }, { x: 0, y: 6000 }], origin: { kind: "traced", underlayId: "u1" } }] });
  run({ type: "create_zone", zoneId: "z1", name: "Zone 1", purpose: "thermal", spaceIds: ["s1"] });
  return m;
}

describe("rolling deploy: an older client receiving spaces, zones and underlays", () => {
  it("draws the plan, validates and builds its network exactly as without them", () => {
    const before = base();
    // The wire is JSON: the old reader gets plain records of kinds it doesn't know.
    const after: ModelState = JSON.parse(JSON.stringify(withSpatialDesign(before))) as ModelState;
    expect(Object.values(after.elements).map((e) => e.kind).sort()).toEqual(["drawing_underlay", "level", "space", "view", "zone"]);

    expect(() => recomputeDerived(after)).not.toThrow();
    expect(validateModel(after)).toEqual(validateModel(before));
    expect(networkOf(after).connectionsOf(asElementId("s1"))).toEqual([]);
    expect(canonicalJson(buildViewScene(after, "v-plan").scene.primitives)).toBe(canonicalJson(buildViewScene(before, "v-plan").scene.primitives));
  });

  it("keeps the records byte for byte through a round trip, so the next client still has them", () => {
    const m = withSpatialDesign(base());
    const wire = JSON.parse(JSON.stringify(m.elements)) as Record<string, BimElement>;
    for (const id of ["s1", "z1", "u1"]) expect(canonicalJson(wire[id])).toBe(canonicalJson(m.elements[id]));
  });

  it("lets other edits go on around them (a level rename commits with spaces present)", () => {
    const m = withSpatialDesign(base());
    const r = executeCommand(m, { type: "update_level", levelId: L1, name: "First floor" });
    expect(r.ok).toBe(true);
  });
});
