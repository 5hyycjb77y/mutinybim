/**
 * @jest-environment node
 *
 * Model settings as the model server stores and sends them. Models first
 * opened in the host app before Oct 22 2026 (site-7303 among them) hold the settings
 * JSON-encoded twice; with the tolerance undefined, every drag_run refused as
 * "pulled back past the elbow". readModelSettings reads both forms and
 * refuses anything that isn't settings.
 */
import { DEFAULT_SETTINGS, executeCommand, readModelSettings, type ModelState } from "../src";

describe("readModelSettings", () => {
  it("reads the object form", () => {
    expect(readModelSettings({ ...DEFAULT_SETTINGS })).toEqual(DEFAULT_SETTINGS);
  });

  it("reads settings JSON-encoded a second time", () => {
    expect(readModelSettings(JSON.stringify(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  it.each([
    ["null", null],
    ["a number", 3],
    ["unreadable text", "{not json"],
    ["a missing tolerance", { minStraightMm: 150, tapEndClearanceMm: 300, minTapSpacingMm: 600 }],
    ["a tolerance in words", { ...DEFAULT_SETTINGS, connectorToleranceMm: "half a mm" }],
  ])("refuses %s", (_label, raw) => {
    expect(() => readModelSettings(raw)).toThrow(/settings|setting/i);
  });

  it("a drag on a model whose settings were read from the string form commits", () => {
    let model: ModelState = { modelId: "s", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: readModelSettings(JSON.stringify(DEFAULT_SETTINGS)) };
    const run = (command: Parameters<typeof executeCommand>[1]) => {
      const res = executeCommand(model, command);
      if (!res.ok) throw new Error(res.error.message);
      model = res.model;
    };
    run({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
    run({
      type: "route_run",
      idPrefix: "r",
      levelId: "lvl-1",
      domain: "duct",
      size: { shape: "rect", width: 355.6, height: 254 },
      elevationMm: 4336.25,
      system: { id: "sa", kind: "supply_air" },
      points: [{ x: -8534.4, y: 9144 }, { x: -4724.4, y: 9144 }, { x: -4724.4, y: 7772.4 }],
    });
    const leg = Object.values(model.elements).find((e) => e.kind === "run_segment" && Math.abs(e.start.y - e.end.y) < 1);
    if (!leg) throw new Error("no level leg");
    expect(executeCommand(model, { type: "drag_run", elementId: leg.id, delta: { x: 0, y: -304.8, z: 0 } }).ok).toBe(true);
  });
});
