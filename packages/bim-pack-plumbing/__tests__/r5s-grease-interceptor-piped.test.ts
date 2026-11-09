/**
 * @jest-environment node
 *
 * The grease interceptor sheet sizes from what is piped to the interceptor
 * (NEXT-BATCH 5b-1, §5). Golden: the 7329 / 7903 kitchen sizing detail
 * (Plumbing Demo 1, f_0013): a three-compartment sink, 28 × 20 × 14 in. × 3
 * bowls = 23,520 in³; 0.75 × 23,520 / 231 = 76.36 gpm at a 1-minute drain-down,
 * 38.18 gpm at 2 minutes, against a 50 gpm interceptor.
 *
 * Fails on the old code: the calc took only a typed fixture list, and the
 * model reader counted loads that *name* the interceptor, never the ones whose
 * drain is drawn to its inlet.
 */
import { builtinPartType, resolveConnectors, withUpgradePolicy, PARTS_CONNECTOR_VALUES_FEATURE, type Command, type ModelState, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { builtinCalcRegistry } from "@permitzip/bim-calc";
import { greaseFixturesPipedTo } from "../src/calc/plumbing/grease-fixtures";
import { DrainageBuilding, FT } from "../../bim-kernel/__tests__/drainage-fixtures";

const PVC4 = { shape: "pipe" as const, nominalMm: 4 * 25.4, material: "pvc" as const };
const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary 1" };
const BOWL = [
  { name: "Compartment length", unit: "in", value: 28 },
  { name: "Compartment width", unit: "in", value: 20 },
  { name: "Compartment depth", unit: "in", value: 14 },
  { name: "Compartments", unit: "", value: 3 },
];

/** GI-1 with a sanitary drain from its inlet and two branches off it: three open ends a fixture can drain from. */
function kitchen(): { b: DrainageBuilding; ends: readonly { hostId: string; port: string }[] } {
  const b = new DrainageBuilding();
  const gi = builtinPartType("builtin:plumbing-grease-interceptor@1");
  if (!gi) throw new Error("starter grease interceptor");
  b.ok({ type: "place_part", partId: "gi-1", typeId: gi.id, partType: gi.definition, levelId: "lvl-1", position: { x: 0, y: 0 }, mark: "GI-1" });
  const inlet = resolveConnectors(gi.definition, {}).find((c) => c.id === "in");
  if (!inlet) throw new Error("GI inlet");
  const [x0, y0] = [inlet.position[0], inlet.position[1]];
  b.ok({ type: "route_run", idPrefix: "k", levelId: "lvl-1", domain: "pipe", size: PVC4, system: SAN, from: { kind: "part", partId: "gi-1", connectorId: "in" }, points: [{ x: x0 - 12 * FT, y: y0 }], flow: "against_points" });
  for (const [prefix, at] of [["b1", 4], ["b2", 8]] as const) {
    b.ok({ type: "route_run", idPrefix: prefix, levelId: "lvl-1", domain: "pipe", size: PVC4, system: SAN, from: { kind: "run_branch", segmentId: "k-s1" }, points: [{ x: x0 - at * FT, y: y0 }, { x: x0 - at * FT, y: y0 + 6 * FT }] });
  }
  const ends: { hostId: string; port: string }[] = [];
  for (const el of Object.values(b.head.elements)) {
    if (el.kind !== "run_segment" || el.systemId !== SAN.id) continue;
    for (const port of ["start", "end"] as const) if (!el.links[port] && !(el.id === "k-s1" && port === "start")) ends.push({ hostId: el.id, port });
  }
  ends.sort((a, b2) => a.hostId.localeCompare(b2.hostId));
  return { b, ends };
}

function sink(id: string, end: { hostId: string; port: string }): Command {
  return { type: "create_load", loads: [{ id, mark: id.toUpperCase(), note: "Three compartment sink", anchor: { kind: "run_end", hostId: end.hostId, port: end.port }, values: { dfu: 3, custom: BOWL } }] };
}

function size(model: ModelState, drainDownMin: 1 | 2) {
  const r = builtinCalcRegistry().run({ calc: "plumbing.grease_interceptor", inputs: { interceptor_id: "gi-1", drain_down_min: drainDownMin, rated_gpm: 50 }, state: "VA", model });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}

describe("grease interceptor sheet sized from what is piped to it", () => {
  it("the kitchen's three open drain ends lead to GI-1's inlet", () => {
    const { ends } = kitchen();
    expect(ends).toHaveLength(3);
  });

  it("one three-bowl sink piped to the inlet: 23,520 in³ → 76.36 gpm (1 min) / 38.18 gpm (2 min) against a 50 gpm GI", () => {
    const { b, ends } = kitchen();
    const [first] = ends;
    if (!first) throw new Error("end");
    b.ok(sink("sk3-1", first));
    const piped = greaseFixturesPipedTo(b.head, "gi-1");
    expect(piped?.fixtures).toEqual([{ label: "SK3-1", quantity: 1, length_in: 28, width_in: 20, depth_in: 14, compartments: 3 }]);
    expect(piped?.loadIds).toEqual(["sk3-1"]);

    const one = size(b.head, 1);
    expect(one.detail).toMatchObject({ volumeGal: expect.closeTo(23520 / 231, 6), requiredGpm: expect.closeTo(76.36, 2) });
    expect(one.values.find((v) => v.key === "pass")?.value).toBe(false);
    expect(one.steps.find((s) => s.label === "Fixtures")?.detail).toBe("1 fixture drains through GI-1");

    const two = size(b.head, 2);
    expect(two.detail).toMatchObject({ requiredGpm: expect.closeTo(38.18, 2) });
    expect(two.values.find((v) => v.key === "pass")?.value).toBe(true);
  });

  it("all three sinks piped: the sheet adds every bowl drawn to the inlet (3 × 23,520 in³)", () => {
    const { b, ends } = kitchen();
    ends.forEach((end, i) => b.ok(sink(`sk3-${i + 1}`, end)));
    const piped = greaseFixturesPipedTo(b.head, "gi-1");
    expect(piped?.loadIds).toEqual(["sk3-1", "sk3-2", "sk3-3"]);
    expect(size(b.head, 1).detail).toMatchObject({ requiredGpm: expect.closeTo((3 * 23520 * 0.75) / 231, 6) });
  });

  it("a fixture piped with no bowl size is named, not guessed; one with nothing piped or named is not counted", () => {
    const { b, ends } = kitchen();
    const [first, second] = ends;
    if (!first || !second) throw new Error("ends");
    b.ok(sink("sk3-1", first));
    b.ok({ type: "create_load", loads: [{ id: "fs-1", mark: "FS-1", anchor: { kind: "run_end", hostId: second.hostId, port: second.port }, values: { dfu: 2 } }] });
    b.ok({ type: "create_load", loads: [{ id: "hs-far", mark: "HS-9", note: "Hand sink", values: { dfu: 1, custom: BOWL } }] });
    const piped = greaseFixturesPipedTo(b.head, "gi-1");
    expect(piped?.missing).toEqual(["FS-1"]);
    expect(piped?.loadIds).toEqual(["fs-1", "sk3-1"]);
    expect(size(b.head, 1).issues.map((i) => i.message)).toContain("FS-1 drains through GI-1 but has no bowl size; give its compartment length, width and depth (or volume) to count it.");
  });

  it("the typed fixture list still works with no model (the 7329 example unchanged)", () => {
    const r = builtinCalcRegistry().run({ calc: "plumbing.grease_interceptor", inputs: { fixtures: [{ label: "P434A-1", length_in: 28, width_in: 20, depth_in: 14, compartments: 3 }], drain_down_min: 1 }, state: "VA" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.run.values.find((v) => v.key === "required_gpm")?.value).toBe(76.4);
  });

  it("asks for the model or the fixtures in plain words", () => {
    const none = builtinCalcRegistry().run({ calc: "plumbing.grease_interceptor", inputs: { drain_down_min: 1 }, state: "VA" });
    expect(none.ok).toBe(false);
    const noModel = builtinCalcRegistry().run({ calc: "plumbing.grease_interceptor", inputs: { interceptor_id: "gi-1" }, state: "VA" });
    if (!noModel.ok) throw new Error(noModel.reason);
    expect(noModel.run.issues[0]?.message).toBe("Give the model to size from what is piped to the interceptor, or list the fixtures.");
  });
});

describe("bowl dimensions from the fixture's drain connector values (parts:connector_values)", () => {
  const SINK: PartTypeDefinition = {
    familyName: "Sink, three compartment",
    typeName: "SPG 28 x 20",
    category: "plumbing_fixture",
    typeParams: [],
    typeValues: {},
    instanceParams: [],
    tagFields: [],
    geometry: [{ kind: "box", center: [0, 0, 450], size: [2134, 610, 900] }],
    symbol: [{ kind: "rect", center: [0, 0], size: [2134, 610] }],
    connectors: [{ id: "w", label: "Waste", domain: "pipe", systemKind: "sanitary", position: [0, 0, 0], direction: [0, 0, -1], shape: "round", diameter: 50.8, values: { "plumb.compartment_length": 28, "plumb.compartment_width": 20, "plumb.compartment_depth": 14, "plumb.compartments": 3 } }],
    source: { kind: "builtin", libraryVersion: "test" },
  };
  const place: Command = { type: "place_part", partId: "sk3-p", typeId: "type-sk3", partType: SINK, levelId: "lvl-1", position: { x: -20 * FT, y: 0 }, mark: "SK3-P" };

  it("a sink whose connector carries its bowls sizes GI-1 with no load values: 76.36 gpm", () => {
    const { b } = kitchen();
    withUpgradePolicy((f) => f === PARTS_CONNECTOR_VALUES_FEATURE, () => b.ok(place));
    b.ok({ type: "create_load", loads: [{ id: "lp-sk3", mark: "SK3-P", anchor: { kind: "part", partId: "sk3-p", connector: "w" }, values: { dfu: 3 }, servedBy: "gi-1" }] });
    expect(greaseFixturesPipedTo(b.head, "gi-1")?.fixtures).toEqual([{ label: "SK3-P", quantity: 1, length_in: 28, width_in: 20, depth_in: 14, compartments: 3 }]);
    expect(size(b.head, 1).detail).toMatchObject({ requiredGpm: expect.closeTo(76.36, 2) });
  });

  it("connector values are written only to a peer that stores them", () => {
    const { b } = kitchen();
    expect(b.try(place)).toBe("Sink, three compartment SPG 28 x 20's Waste values can't be saved yet: the model server this model is open on is an older version that doesn't store connector values. Try again once the server is updated");
  });
});
