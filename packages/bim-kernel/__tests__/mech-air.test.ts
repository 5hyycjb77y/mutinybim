/**
 * @jest-environment node
 *
 * The mechanical air side (wave 2 `mech-air`): a rooftop unit feeding ceiling
 * diffusers on the floor below, through the roof. Each block fails on the
 * kernel before it: a route to a connector on another level was refused
 * ("is on another level; route on its level"), a part had no mount, the
 * built-in RTU / MAU had no outdoor-air opening, there was no hood, no flex
 * duct and no mounting plane.
 */
import {
  BUILTIN_PART_TYPES,
  DEFAULT_SETTINGS,
  FLEX_LENGTH_WARNING_MM,
  applyChangeset,
  builtinPartType,
  canonicalJson,
  commandIssueMessage,
  commandSchema,
  executeCommand,
  flexLengthMm,
  partConnector,
  placedConnectors,
  placedGeometry,
  placedSymbol,
  planCommit,
  validateModel,
  viewLevelElements,
  type BimElement,
  type Changeset,
  type Command,
  type LibraryEntry,
  type ModelState,
  type PartInstance,
  type PartTypeElement,
  type RunSegment,
  type ViewElement,
} from "../src";
import { elementSolid } from "../src/drawing/solids";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";

// The built-in equipment types (the makeup air unit) are the first-party add-ons' rows since round 6, as in every host.
installFirstPartyAddOns();

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-23T00:00:00.000Z";

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@2");
const DIFFUSER = lib("builtin:supply-diffuser-24@1");

let counter = 0;
class Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor(start: ModelState) {
    this.head = start;
  }
  submit(command: Command) {
    counter += 1;
    const base = this.head.revision;
    const decision = planCommit(this.head, [], { idempotencyKey: `k-${counter}`, baseRevision: base, actor: { id: "priya", name: "Priya", kind: "human" }, command, clientSessionId: "tab" }, NOW, this.log);
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command): Changeset {
    const d = this.submit(command);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  /** What the edit says it did (the result's summary), then commit it. */
  said(command: Command): string {
    const r = executeCommand(this.head, command);
    if (!r.ok) throw new Error(`expected ${command.type} to run: ${r.error.message}`);
    this.ok(command);
    return (r.summary ?? []).join(" ");
  }
  refused(command: Command): string {
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    return d.error.message;
  }
  el(id: string): BimElement {
    const found = this.head.elements[id];
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }
  part(id: string): PartInstance {
    const el = this.el(id);
    if (el.kind !== "part") throw new Error(`${id} is a ${el.kind}`);
    return el;
  }
  type(id: string): PartTypeElement {
    const el = this.el(id);
    if (el.kind !== "part_type") throw new Error(`${id} is a ${el.kind}`);
    return el;
  }
  runs(prefix: string): RunSegment[] {
    return Object.values(this.head.elements).filter((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith(prefix));
  }
}

function place(m: Model, partId: string, entry: LibraryEntry, levelId: string, x: number, y: number, extra: Partial<Extract<Command, { type: "place_part" }>> = {}): void {
  m.ok({ type: "place_part", partId, typeId: entry.id, ...(m.head.elements[entry.id] ? {} : { partType: entry.definition }), levelId, position: { x, y }, ...extra });
}

/** Level 1 at 0 and the roof at 14 ft; an RTU on a 2 ft curb on the roof, a ceiling diffuser on Level 1 at 9 ft. */
function rooftopJob(): Model {
  const m = new Model({ modelId: "mech-air", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS });
  m.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 14 * FT });
  place(m, "rtu", RTU, "lvl-roof", 0, 0, { offsetMm: 2 * FT, mark: "RTU-1" });
  place(m, "sd-1", DIFFUSER, "lvl-1", 20 * FT, 0, { offsetMm: 9 * FT, mark: "SD-1" });
  return m;
}

const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
const TRUNK = { shape: "rect" as const, width: 14 * IN, height: 10 * IN };

/** From the RTU's downflow supply on the roof, through the roof, along the Level 1 ceiling plenum (11.5 ft) to the diffuser's neck. */
function rtuToDiffuser(m: Model): Changeset {
  return m.ok({
    type: "route_run",
    idPrefix: "sa",
    levelId: "lvl-roof",
    domain: "duct",
    size: TRUNK,
    // Heights from the roof's floor: the plenum is 2.5 ft below it.
    elevationMm: -2.5 * FT,
    system: SA,
    points: [],
    from: { kind: "part", partId: "rtu", connectorId: "supply" },
    to: { kind: "part", partId: "sd-1", connectorId: "neck" },
  });
}

describe("a run that crosses levels (bug log #14)", () => {
  it("routes from the RTU on the roof down to a diffuser on Level 1, linked both ends, with no open issues", () => {
    const m = rooftopJob();
    rtuToDiffuser(m);
    expect(m.part("rtu").links?.supply?.elementId).toMatch(/^sa-/);
    expect(m.part("sd-1").links?.neck?.elementId).toMatch(/^sa-/);
    expect(validateModel(m.head)).toEqual([]);
    // Every piece of the run measures its heights from the roof (the level it starts on).
    for (const s of m.runs("sa-")) expect(s.levelId).toBe("lvl-roof");
  });

  it("cuts the riser where it passes the roof, so the roof plan and the Level 1 plan each draw their piece", () => {
    const m = rooftopJob();
    rtuToDiffuser(m);
    const risers = m.runs("sa-").filter((s) => Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) < 1 && Math.abs(s.end.z - s.start.z) > 1);
    const floors = risers.map((s) => s.partition?.level).sort();
    expect(floors).toEqual(["Level 1", "Level 1", "Roof"]);
    const roofPiece = risers.find((s) => s.partition?.level === "Roof");
    expect(roofPiece && Math.min(roofPiece.start.z, roofPiece.end.z)).toBeCloseTo(0, 3);
    const plan = (level: string): ViewElement => ({ id: `v-${level}` as ViewElement["id"], kind: "view", version: 0, authoredRev: {}, name: level, viewType: "floor_plan", props: { level } } as ViewElement);
    const onLevel1 = new Set<string>(viewLevelElements(m.head, plan("Level 1")).map((e) => e.id));
    const onRoof = new Set<string>(viewLevelElements(m.head, plan("Roof")).map((e) => e.id));
    expect(onLevel1.has("sd-1")).toBe(true);
    expect(onRoof.has("rtu")).toBe(true);
    expect(onRoof.has(roofPiece?.id ?? "")).toBe(true);
    expect(onLevel1.has(roofPiece?.id ?? "")).toBe(false);
    // The level run in the Level 1 plenum is on the Level 1 plan.
    const level = m.runs("sa-").find((s) => Math.abs(s.end.z - s.start.z) < 1 && Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > 5 * FT);
    expect(level && onLevel1.has(level.id)).toBe(true);
  });

  it("files a branch routed on the roof's trunk, down in the Level 1 plenum, under Level 1", () => {
    const m = rooftopJob();
    m.ok({ type: "route_run", idPrefix: "t1", levelId: "lvl-roof", domain: "duct", size: TRUNK, elevationMm: -2.5 * FT, system: SA, points: [{ x: -400, y: 0 }, { x: 20 * FT, y: 0 }], from: { kind: "part", partId: "rtu", connectorId: "supply" } });
    const trunk = m.runs("t1-").find((s) => Math.abs(s.end.z - s.start.z) < 1 && Math.hypot(s.end.x - s.start.x, s.end.y - s.start.y) > 10 * FT);
    m.ok({ type: "route_run", idPrefix: "b1", levelId: "lvl-roof", domain: "duct", size: { shape: "round", diameter: 8 * IN }, system: SA, points: [{ x: 10 * FT, y: 0 }, { x: 10 * FT, y: 6 * FT }], from: { kind: "run_branch", segmentId: trunk?.id ?? "" } });
    expect(trunk?.partition?.level).toBe("Level 1");
    for (const s of m.runs("b1-")) expect(s.partition?.level).toBe("Level 1");
    // A run that stays on its own storey keeps its level as before.
    m.ok({ type: "route_run", idPrefix: "own", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 10 * FT, system: SA, points: [{ x: 30 * FT, y: 0 }, { x: 40 * FT, y: 0 }] });
    for (const s of m.runs("own-")) expect(s.partition?.level).toBe("Level 1");
  });

  it("checks the diffuser's link from its own floor: moving it up 3 inches drags the run, it doesn't read as disconnected", () => {
    const m = rooftopJob();
    rtuToDiffuser(m);
    m.ok({ type: "move_elements", ids: ["sd-1"], delta: { x: 0, y: 0 }, dzMm: 3 * IN });
    expect(validateModel(m.head)).toEqual([]);
  });

  it("still refuses a branch off a trunk on another level, saying where to route it", () => {
    const m = rooftopJob();
    m.ok({ type: "route_run", idPrefix: "t1", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 11 * FT, system: SA, points: [{ x: 5 * FT, y: 10 * FT }, { x: 25 * FT, y: 10 * FT }] });
    const trunk = m.runs("t1-")[0];
    const why = m.refused({ type: "route_run", idPrefix: "b1", levelId: "lvl-roof", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: -3 * FT, system: SA, points: [{ x: 10 * FT, y: 10 * FT }, { x: 10 * FT, y: 15 * FT }], from: { kind: "run_branch", segmentId: trunk?.id ?? "" } });
    expect(why).toMatch(/on Level 1; a branch leaves its trunk on the trunk's level/);
  });
});

describe("air terminal mount (bug log #14, orientation)", () => {
  it("places a register turned over: neck down, below its insertion point", () => {
    const m = rooftopJob();
    place(m, "fr-1", DIFFUSER, "lvl-1", 5 * FT, 5 * FT, { offsetMm: 0, mount: "turned_over", mark: "FR-1" });
    const w = partConnector(m.part("fr-1"), m.type(DIFFUSER.id), "neck");
    expect(w?.direction).toEqual({ x: 0, y: 0, z: -1 });
    expect(w?.position.z).toBeCloseTo(-150, 3);
    // The face (the box at the insertion point) is now above the neck.
    const body = placedGeometry(m.type(DIFFUSER.id), m.part("fr-1"))[0];
    expect(body?.kind === "box" && body.center[2]).toBeCloseTo(-25, 3);
  });

  it("places a sidewall register on its side: face out along its rotation, neck back", () => {
    const m = rooftopJob();
    place(m, "sw-1", DIFFUSER, "lvl-1", 5 * FT, 5 * FT, { offsetMm: 7 * FT, rotationDeg: 90, mount: "on_side" });
    const w = partConnector(m.part("sw-1"), m.type(DIFFUSER.id), "neck");
    // Drawn neck up; on its side the neck points back (west), turned 90° it points south.
    expect(w?.direction.x).toBeCloseTo(0, 6);
    expect(w?.direction.y).toBeCloseTo(-1, 6);
    expect(w?.direction.z).toBeCloseTo(0, 6);
    expect(placedSymbol(m.type(DIFFUSER.id), m.part("sw-1")).length).toBeGreaterThan(0);
  });

  it("turns a placed part over, and refuses while a run is connected", () => {
    const m = rooftopJob();
    m.ok({ type: "set_parameters", id: "sd-1", scope: "instance", mount: "turned_over" });
    expect(m.part("sd-1").mount).toBe("turned_over");
    m.ok({ type: "set_parameters", id: "sd-1", scope: "instance", mount: "as_drawn" });
    expect(m.part("sd-1").mount).toBeUndefined();
    rtuToDiffuser(m);
    expect(m.refused({ type: "set_parameters", id: "sd-1", scope: "instance", mount: "turned_over" })).toMatch(/disconnect them first/);
  });
});

describe("outdoor air on built-in equipment (bug log #19)", () => {
  it.each(["builtin:rtu-5-ton@2", "builtin:makeup-air-unit-480@2", "builtin:inline-fan-oa-10@1"])("%s has an outdoor-air opening carrying its outdoor airflow", (id) => {
    const t = lib(id);
    const oa = placedConnectors({ id: t.id, kind: "part_type", version: 0, authoredRev: {}, definition: t.definition } as PartTypeElement, { values: {} }).filter((c) => c.systemKind === "outside_air");
    expect(oa.length).toBeGreaterThan(0);
    expect(oa[0]?.flow).toBe(t.definition.typeValues.outdoor_cfm);
  });

  it("schedules the VAV's zone outdoor airflow (a VAV takes primary air, so it has no outdoor-air opening)", () => {
    const vav = lib("builtin:vav-8@2");
    expect(vav.definition.instanceParams.some((p) => p.name === "outdoor_cfm")).toBe(true);
    expect(vav.definition.connectors.some((c) => c.systemKind === "outside_air")).toBe(false);
  });

  it("keeps earlier versions readable for models that placed them, and offers only the current ones", () => {
    expect(builtinPartType("builtin:rtu-5-ton@1")).toBeDefined();
    expect(builtinPartType("builtin:makeup-air-unit-480@1")).toBeDefined();
    const offered = new Set(BUILTIN_PART_TYPES.map((t) => t.id));
    expect(offered.has("builtin:rtu-5-ton@1")).toBe(false);
    expect(offered.has("builtin:rtu-5-ton@2")).toBe(true);
  });
});

describe("hood, louver or screen on an intake (bug log #26)", () => {
  it("draws the RTU's economizer hood out past the end of the unit, in the printed solid too", () => {
    const m = rooftopJob();
    const solid = elementSolid(m.head, m.el("rtu"), 0);
    expect(solid?.pieces.length).toBe(2);
    const xs = (i: number) => (solid?.pieces[i]?.r0 ?? []).map((q) => q.x);
    const unitEnd = Math.max(...xs(0));
    expect(Math.max(...xs(1))).toBeGreaterThan(unitEnd + 250);
    // The plan symbol has the hood's outline and its V.
    expect(placedSymbol(m.type(RTU.id), m.part("rtu")).length).toBeGreaterThan(RTU.definition.symbol.length + 2);
  });

  it("swaps the hood for a louver, takes it off, and puts the type's back", () => {
    const m = rooftopJob();
    const boxes = () => placedGeometry(m.type(RTU.id), m.part("rtu")).length;
    m.ok({ type: "set_parameters", id: "rtu", scope: "instance", intakes: { outdoor_air: "louver" } });
    expect(m.part("rtu").intakes).toEqual({ outdoor_air: "louver" });
    expect(boxes()).toBe(2);
    m.ok({ type: "set_parameters", id: "rtu", scope: "instance", intakes: { outdoor_air: "none" } });
    expect(boxes()).toBe(1);
    m.ok({ type: "set_parameters", id: "rtu", scope: "instance", intakes: { outdoor_air: null } });
    expect(m.part("rtu").intakes).toBeUndefined();
    expect(boxes()).toBe(2);
  });

  it("refuses a hood on an opening that isn't to outdoors", () => {
    const m = rooftopJob();
    expect(m.refused({ type: "set_parameters", id: "rtu", scope: "instance", intakes: { supply: "hood" } })).toMatch(/isn't a duct opening to outdoors/);
  });
});

describe("flex duct (mechanical WS4 T2)", () => {
  /** A Level 1 trunk at 11 ft with an 8" branch heading toward the diffuser and stopping 3 ft short of it. */
  function withBranch(): Model {
    const m = rooftopJob();
    m.ok({ type: "route_run", idPrefix: "t1", levelId: "lvl-1", domain: "duct", size: TRUNK, elevationMm: 11 * FT, system: SA, points: [{ x: 10 * FT, y: -10 * FT }, { x: 10 * FT, y: 10 * FT }] });
    const trunk = m.runs("t1-")[0];
    m.ok({ type: "route_run", idPrefix: "b1", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, system: SA, points: [{ x: 10 * FT, y: 0 }, { x: 17 * FT, y: 0 }], from: { kind: "run_branch", segmentId: trunk?.id ?? "" } });
    return m;
  }

  function openEnd(m: Model): { elementId: string; port: string } {
    const end = m.runs("b1-").find((s) => !s.links.end);
    if (!end) throw new Error("no open branch end");
    return { elementId: end.id, port: "end" };
  }

  it("runs one round flex from the branch's open end to the diffuser neck, sized to the neck, linked both ends, carrying its airflow", () => {
    const m = withBranch();
    const said = m.said({ type: "route_flex", segmentId: "fx-1", from: openEnd(m), to: { partId: "sd-1", connectorId: "neck" } });
    const flex = m.el("fx-1");
    if (flex.kind !== "run_segment") throw new Error("flex isn't a segment");
    expect(flex.size).toEqual({ shape: "round", diameter: 8 * IN });
    expect(flex.flex?.path.length).toBeGreaterThan(4);
    expect(flex.links.end).toEqual({ elementId: "sd-1", port: "neck" });
    expect(m.part("sd-1").links?.neck).toEqual({ elementId: "fx-1", port: "end" });
    expect(flex.flow).toBe(150);
    expect(validateModel(m.head)).toEqual([]);
    expect(flexLengthMm(flex)).toBeGreaterThan(3 * FT);
    expect(said).toMatch(/^8" flex, \d+(\.\d)? ft, from /);
  });

  it("bends to follow the diffuser when it moves, still linked", () => {
    const m = withBranch();
    m.ok({ type: "route_flex", segmentId: "fx-1", from: openEnd(m), to: { partId: "sd-1", connectorId: "neck" } });
    const before = m.el("fx-1");
    m.ok({ type: "move_elements", ids: ["sd-1"], delta: { x: 1 * FT, y: 1 * FT } });
    const after = m.el("fx-1");
    expect(after.kind === "run_segment" && before.kind === "run_segment" && after.end.x - before.end.x).toBeCloseTo(1 * FT, 3);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("warns past 6 ft and refuses a neck that doesn't match the end", () => {
    const m = withBranch();
    place(m, "sd-far", DIFFUSER, "lvl-1", 26 * FT, 4 * FT, { offsetMm: 9 * FT, mark: "SD-2" });
    const said = m.said({ type: "route_flex", segmentId: "fx-far", from: openEnd(m), to: { partId: "sd-far", connectorId: "neck" } });
    const far = m.el("fx-far");
    expect(far.kind === "run_segment" && flexLengthMm(far)).toBeGreaterThan(FLEX_LENGTH_WARNING_MM);
    expect(said).toMatch(/Longer than 6 ft/);
    const grille = lib("builtin:return-grille-24@1");
    place(m, "rg-1", grille, "lvl-1", 20 * FT, 5 * FT, { offsetMm: 9 * FT });
    expect(m.refused({ type: "route_flex", segmentId: "fx-bad", from: { elementId: "fx-far", port: "start" }, to: { partId: "rg-1", connectorId: "neck" } })).toMatch(/already connected|return air/);
  });

  it("draws in plan as two curved edges with ticks across, labelled flex", () => {
    const m = withBranch();
    m.ok({ type: "route_flex", segmentId: "fx-1", from: openEnd(m), to: { partId: "sd-1", connectorId: "neck" } });
    const solid = elementSolid(m.head, m.el("fx-1"), 0);
    expect(solid?.pieces.length).toBeGreaterThan(4);
    expect(solid?.centerline?.length).toBe((solid?.pieces.length ?? 0));
  });
});

describe("mounting planes (mechanical WS4 T1)", () => {
  function withPlane(): Model {
    const m = rooftopJob();
    m.ok({ type: "create_mounting_plane", planeId: "mp-1", levelId: "lvl-1", name: "Open office 9'-0\"", heightMm: 9 * FT, corner1: { x: 0, y: -10 * FT }, corner2: { x: 30 * FT, y: 10 * FT } });
    return m;
  }

  it("places a diffuser on the plane at its height, where there is no ceiling", () => {
    const m = withPlane();
    place(m, "sd-p", DIFFUSER, "lvl-1", 12 * FT, 2 * FT, { planeId: "mp-1" });
    expect(m.part("sd-p").offsetMm).toBeCloseTo(9 * FT, 3);
    expect(m.part("sd-p").planeId).toBe("mp-1");
  });

  it("moves its parts, and the duct connected to them, when its height changes", () => {
    const m = withPlane();
    place(m, "sd-p", DIFFUSER, "lvl-1", 12 * FT, 2 * FT, { planeId: "mp-1" });
    m.ok({ type: "route_run", idPrefix: "d1", levelId: "lvl-1", domain: "duct", size: { shape: "round", diameter: 8 * IN }, elevationMm: 11 * FT, system: SA, points: [{ x: 6 * FT, y: 2 * FT }], to: { kind: "part", partId: "sd-p", connectorId: "neck" } });
    const said = m.said({ type: "set_mounting_plane", planeId: "mp-1", heightMm: 9.5 * FT });
    expect(m.part("sd-p").offsetMm).toBeCloseTo(9.5 * FT, 3);
    expect(validateModel(m.head)).toEqual([]);
    expect(said).toMatch(/moved up 0.5 ft with it/);
  });

  it("refuses a part outside the plane, or with its own height as well", () => {
    const m = withPlane();
    expect(m.refused({ type: "place_part", partId: "x", typeId: DIFFUSER.id, levelId: "lvl-1", position: { x: 50 * FT, y: 0 }, planeId: "mp-1" })).toMatch(/isn't on Open office/);
    expect(m.refused({ type: "place_part", partId: "x", typeId: DIFFUSER.id, levelId: "lvl-1", position: { x: 5 * FT, y: 0 }, planeId: "mp-1", offsetMm: 0 })).toMatch(/takes the plane's height/);
  });

  it("refuses a key the new commands don't take, by name (strict schemas)", () => {
    const input = { type: "set_mounting_plane", planeId: "mp-1", height_ft: 9 };
    const parsed = commandSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(commandIssueMessage(parsed.error, input)).toMatch(/doesn't take height_ft.*heightMm \(mm\)/);
    expect(commandSchema.safeParse({ type: "place_part", partId: "p", typeId: "t", levelId: "l", position: { x: 0, y: 0 }, flip: true }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "place_part", partId: "p", typeId: "t", levelId: "l", position: { x: 0, y: 0 }, mount: "turned_over", planeId: "mp-1" }).success).toBe(true);
  });

  it("executes straight from the kernel too", () => {
    expect(executeCommand(withPlane().head, { type: "set_mounting_plane", planeId: "mp-1", name: "Mezzanine" }).ok).toBe(true);
  });
});

describe("seating a part on its host carries its connected duct (bug log #39)", () => {
  /** A linked roof whose top is `topFromRoofFloorMm` above the Roof level's floor (the RTU now sits 2 ft above it). */
  function seatOn(topFromRoofFloorMm: number): Command {
    return {
      type: "set_part_host",
      ids: ["rtu"],
      host: { kind: "linked", referenceId: "ref-arch", name: 'Basic Roof:Generic - 12":883620', surface: "roof", topMm: 14 * FT + topFromRoofFloorMm },
      curbMm: 0,
    };
  }
  /** Where the run meets the RTU's supply (the transition on the unit's opening). */
  function supplyEnd(m: Model): { id: string; z: number; x: number; y: number } {
    const link = m.part("rtu").links?.supply;
    if (!link) throw new Error("RTU supply isn't connected");
    const el = m.el(link.elementId);
    const p = el.kind === "run_segment" ? (link.port === "start" ? el.start : el.end) : el.kind === "run_fitting" ? el.ports.find((q) => q.id === link.port)?.position : undefined;
    if (!p) throw new Error(`${link.elementId} has no port ${link.port}`);
    return { id: el.id, ...p };
  }

  it("seats the RTU 965 mm higher and its supply riser stretches up with it, linked and valid", () => {
    const m = rooftopJob();
    rtuToDiffuser(m);
    const before = supplyEnd(m);
    // Production (site-7352 Rev 197): RTU-1 was 38" (965.2 mm) below the roof top; seat with no curb.
    m.ok(seatOn(2 * FT + 965.2));
    // offset = roof top above the level (2 ft + 965.2) + curb 0.
    expect(m.part("rtu").offsetMm).toBeCloseTo(2 * FT + 965.2, 3);
    const after = supplyEnd(m);
    expect(after.id).toBe(before.id);
    expect(after.z - before.z).toBeCloseTo(965.2, 3);
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("refuses a seat the riser can't follow, naming the run, the unit, how far, and what to do instead", () => {
    const m = rooftopJob();
    rtuToDiffuser(m);
    // The riser piece above the roof is 2 ft = 609.6 mm; 500 mm lower leaves 109.6 mm, under the 150 mm minimum straight piece.
    const short = m.refused(seatOn(2 * FT - 500));
    expect(short).toMatch(/its connected run sa-s\d+/);
    expect(short).toMatch(/Seating RTU-1 moves it down 500 mm/);
    expect(short).toMatch(/shorter than the 150 mm minimum straight piece/);
    expect(short).toMatch(/move RTU-1 and the run together \(then set the host with seat off\), disconnect the run, or re-route it/);
    // 3 ft (914.4 mm) lower would pull that piece's top 304.8 mm past its bottom, folding it back over the riser below: refused, not saved inside out.
    const through = m.refused(seatOn(-1 * FT));
    expect(through).toMatch(/its connected run sa-s\d+/);
    expect(through).toMatch(/Seating RTU-1 moves it down 914 mm/);
    expect(through).toMatch(/doubles back on .* where they join/);
    // Move used to save the same fold silently.
    expect(m.refused({ type: "move_elements", ids: ["rtu"], delta: { x: 0, y: 0 }, dzMm: -3 * FT })).toMatch(/doubles back on .* where they join/);
    // Move used to save the same fold silently.
    expect(m.refused({ type: "move_elements", ids: ["rtu"], delta: { x: 0, y: 0 }, dzMm: -3 * FT })).toMatch(/doubles back on .* where they join/);
    expect(m.part("rtu").offsetMm).toBeCloseTo(2 * FT, 3);
  });
});
