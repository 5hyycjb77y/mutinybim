/**
 * @jest-environment node
 * @mutinybim-bare-kernel
 *
 * Round 11 lane K11: without the Mechanical add-on, the three round-1
 * commands' cases for its kinds are refused naming the add-on, and the same
 * commands on routed runs (which are the kernel's own kinds) keep working.
 *
 * Fails on round 10's code: the kernel ran the duct halves itself, so a
 * bare kernel slid a tap (or refused it as "no add-on lets a duct_segment
 * carry branches") and moved a unit with no add-on loaded.
 */
import { DEFAULT_SETTINGS, SERVICE_POINT, builtinPartType, elementsOfKind, executeCommand, type Command, type LibraryEntry, type ModelState } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { ELECTRICAL_MANIFEST, MECHANICAL_MANIFEST, PackSet, contribute, definePack, installedFirstPartyPacks, withPackSet } from "../src/packs";
import { MECHANICAL_SERVICE_ROWS } from "@permitzip/bim-pack-mechanical";
import { ELECTRICAL_SERVICE_ROWS } from "@permitzip/bim-pack-electrical";

const NOT_LOADED = "This model uses Mechanical, which isn't loaded here";
const FT = 304.8;
const IN = 25.4;

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`no built-in part type ${id}`);
  return t;
}

function run(m: ModelState, command: Command): ModelState {
  const r = executeCommand(m, command);
  if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
  return r.model;
}

/**
 * An RTU and a diffuser joined by a routed duct, with a routed branch on it
 * (routing.test.ts's air fixture). Since round 14 the supply air row is
 * Mechanical's (and the unit's Power row Electrical's), so the model is drawn
 * with those service rows in force (as a model stored where they were on); the
 * claims below run with no add-on.
 */
function routedAir(): ModelState {
  const services = PackSet.create([definePack(ELECTRICAL_MANIFEST, [contribute(SERVICE_POINT, ELECTRICAL_SERVICE_ROWS)]), definePack(MECHANICAL_MANIFEST, [contribute(SERVICE_POINT, MECHANICAL_SERVICE_ROWS)])]);
  return withPackSet(services, drawRoutedAir);
}

function drawRoutedAir(): ModelState {
  const RTU = lib("builtin:rtu-5-ton@1");
  const DIFFUSER = lib("builtin:supply-diffuser-24@1");
  let m: ModelState = { modelId: "k11-bare-routed", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = run(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  const place = (partId: string, entry: LibraryEntry, x: number, y: number, offsetMm: number, mark: string) => {
    m = run(m, { type: "place_part", partId, typeId: entry.id, ...(m.elements[entry.id] ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y }, offsetMm, mark });
  };
  place("rtu", RTU, 0, 0, 12 * FT, "RTU-1");
  place("sd-a", DIFFUSER, 20 * FT, 0, 8 * FT, "SD-1");
  place("sd-b", DIFFUSER, 10 * FT, 4 * FT, 8 * FT, "SD-2");
  const system = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
  m = run(m, { type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system, points: [], from: { kind: "part", partId: "rtu", connectorId: "supply" }, to: { kind: "part", partId: "sd-a", connectorId: "neck" } });
  m = run(m, { type: "route_run", idPrefix: "br", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: 10 * FT, system, points: [{ x: 8 * FT, y: 0 }, { x: 8 * FT, y: 4 * FT }], from: { kind: "run_branch", segmentId: "trunk-s2" }, to: { kind: "part", partId: "sd-b", connectorId: "neck" } });
  return m;
}

describe("k11 claims on a bare kernel", () => {
  it("is a bare kernel", () => {
    expect(installedFirstPartyPacks().map((p) => p.manifest.id)).not.toContain("mechanical");
  });

  it("refuses the round-1 kinds' cases naming the add-on, and changes nothing", () => {
    const demo = createDemoModel("k11-bare");
    const tap = elementsOfKind(demo.elements, "tap")[0];
    const seg = elementsOfKind(demo.elements, "duct_segment")[0];
    const unit = elementsOfKind(demo.elements, "equipment")[0];
    if (!tap || !seg || !unit) throw new Error("the demo model has no tap, duct or unit");
    const commands: Command[] = [
      { type: "slide_branch", tapId: tap.id, s: 1500 },
      { type: "resize_run", segmentId: seg.id, profile: { shape: "rect", width: 500, height: 300 } },
      { type: "move_equipment", equipmentId: unit.id, delta: { x: 100, y: 0 } },
    ];
    for (const command of commands) {
      const r = executeCommand(demo, command);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toEqual({ code: "invalid_value", message: NOT_LOADED, elementIds: [Reflect.get(command, command.type === "slide_branch" ? "tapId" : command.type === "resize_run" ? "segmentId" : "equipmentId")] });
    }
  });

  it("a missing target is still 'does not exist', and a kernel kind is refused in words", () => {
    const demo = createDemoModel("k11-bare-2");
    const missing = executeCommand(demo, { type: "slide_branch", tapId: "nope", s: 1 });
    expect(!missing.ok && missing.error.code).toBe("element_not_found");
    const wall = { id: "W-1", version: 1, authoredRev: {}, kind: "wall", start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, thickness: 100, height: 3000, wallType: "w" } as const;
    const withWall: ModelState = { ...demo, elements: { ...demo.elements, [wall.id]: wall as unknown as ModelState["elements"][string] } };
    const r = executeCommand(withWall, { type: "move_equipment", equipmentId: wall.id, delta: { x: 1, y: 0 } });
    expect(!r.ok && r.error).toEqual({ code: "wrong_kind", message: "W-1 is a wall, and no add-on on this model handles move equipment for one", elementIds: ["W-1"] });
  });

  it("routed runs keep sliding and resizing with no add-on", () => {
    const m = routedAir();
    const slid = run(m, { type: "slide_branch", tapId: "br-f3", s: 6 * FT + 400 });
    const tap = slid.elements["br-f3"];
    expect(tap?.kind === "run_fitting" && tap.ports[0]?.position.x).toBeCloseTo(6 * FT);
    const resized = run(m, { type: "resize_run", segmentId: "trunk-s2", profile: { shape: "rect", width: 16 * IN, height: 10 * IN } });
    const s2 = resized.elements["trunk-s2"];
    expect(s2?.kind === "run_segment" && s2.size).toEqual({ shape: "rect", width: 16 * IN, height: 10 * IN });
  });
});
