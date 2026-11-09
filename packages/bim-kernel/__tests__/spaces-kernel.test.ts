/**
 * @jest-environment node
 *
 * Spaces and zones drawn by people (ROADMAP F3; product decision, Oct 27, decision 3):
 * most jobs have only a PDF, so a person places a drawing on a level,
 * calibrates it, and traces spaces over it. Area always comes from the
 * outline; occupants come from the use's density unless typed; a zone names
 * the equipment that serves it; "Make spaces from rooms" is one command.
 *
 * Before this change none of these commands existed: every command below was
 * refused as "not a space command", and no schedule could list a space.
 */
import { applyChangeset, asElementId, canonicalJson, commandSchema, modelSpaceLocator, planCommit, type Changeset, type Command, DEFAULT_SETTINGS, evaluateScheduleV2, executeCommand, fieldProviderRegistry, type BimElement, type ModelState, type ScheduleDefinitionV2 } from "../src";
import { buildRowSet } from "../src/schedules/engine";
import { executeSpaceDesignCommand, spaceIdForRoom, type SpaceDesignCommand } from "../src/spaces/space-commands";
import { densityEvaluationCount, densityLoad } from "../src/spaces/space-density";
import { parseDrawingScale, sourceToModel, spaceAreaM2 } from "../src/spaces/space-geometry";
import { advanceSpaceIndex, plannedSpaces, spaceAt, spaceIndexStats, spaceOf, spacesOfZone, spacesOnLevel, zonesOfSpace, zonesServedBy } from "../src/spaces/space-index";
import { designOccupants, type PinnedSpaceUse } from "../src/spaces/space-use";
import type { DrawingUnderlay, Space, Zone } from "../src/spaces/types";

const FT = 304.8;
const FT2_PER_M2 = 10.7639104;
const L1 = asElementId("L1");

const DINING: PinnedSpaceUse = {
  libraryId: "builtin:space-uses",
  useId: "restaurant_dining",
  name: "Restaurant dining rooms",
  occupantsPerM2: 70 / 1000 * FT2_PER_M2,
  rates: [
    { key: "cfm", per: "occupant", value: 7.5 },
    { key: "cfm", per: "area", value: 0.18 * FT2_PER_M2 },
    { key: "va", per: "area", value: 1.5 * FT2_PER_M2 },
  ],
};
const KITCHEN: PinnedSpaceUse = { libraryId: "builtin:space-uses", useId: "kitchen_cooking", name: "Kitchens (cooking)", occupantsPerM2: 20 / 1000 * FT2_PER_M2, rates: [{ key: "cfm", per: "occupant", value: 7.5 }, { key: "cfm", per: "area", value: 0.12 * FT2_PER_M2 }] };

function emptyModel(extra: readonly BimElement[] = []): ModelState {
  const level: BimElement = { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  const elements: Record<string, BimElement> = { [L1]: level };
  for (const el of extra) elements[el.id] = el;
  return { modelId: "spaces", revision: 0 as ModelState["revision"], elements, connections: [], settings: DEFAULT_SETTINGS };
}

class Model {
  constructor(public head: ModelState) {}
  summary: readonly string[] = [];

  ok(command: SpaceDesignCommand): readonly string[] {
    const r = executeSpaceDesignCommand(this.head, command);
    if (!r.ok) throw new Error(`${command.type}: ${r.error.message}`);
    advanceSpaceIndex(this.head.elements, r.model.elements, r.changedIds, r.removedIds);
    this.head = { ...r.model, revision: (this.head.revision + 1) as ModelState["revision"] };
    this.summary = r.summary ?? [];
    return r.changedIds;
  }

  refused(command: SpaceDesignCommand): { code: string; message: string } {
    const r = executeSpaceDesignCommand(this.head, command);
    if (r.ok) throw new Error(`${command.type} was expected to be refused`);
    return r.error;
  }

  space(id: string): Space {
    const el = this.head.elements[id];
    if (el?.kind !== "space") throw new Error(`${id} is not a space`);
    return el;
  }

  zone(id: string): Zone {
    const el = this.head.elements[id];
    if (el?.kind !== "zone") throw new Error(`${id} is not a zone`);
    return el;
  }

  underlay(id: string): DrawingUnderlay {
    const el = this.head.elements[id];
    if (el?.kind !== "drawing_underlay") throw new Error(`${id} is not an underlay`);
    return el;
  }
}

const rect = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const SPACE_SCHEDULE: ScheduleDefinitionV2 = {
  name: "Space schedule",
  source: { kind: "classes", classes: ["gen.space"], includeSubclasses: true },
  columns: [
    { id: "number", kind: "field", path: "number" },
    { id: "name", kind: "field", path: "name" },
    { id: "area", kind: "field", path: "area", total: true },
    { id: "occupants", kind: "field", path: "occupants", total: true },
  ],
  filters: [],
  sort: [{ path: "number", direction: "asc" }],
  groups: [],
  grandTotals: true,
  itemize: true,
  presentation: { kind: "list" },
  display: { textSizeMm: 2.5, emptyText: "NONE" },
};

describe("the no-BIM-link job: a PDF, calibrated, traced", () => {
  it("places a PDF page, refuses tracing until it is calibrated, then traces Kitchen and Dining with area, occupants and a schedule", () => {
    const m = new Model(emptyModel());
    m.ok({ type: "place_underlay", underlayId: "u-a101", levelId: L1, source: { format: "pdf", provider: "host.workspace", ref: "file-a101", page: 1, name: "A-101 Floor Plan.pdf" } });
    expect(m.summary.join(" ")).toMatch(/isn't calibrated yet, so tracing over it is off/);

    const traceTooEarly = m.refused({ type: "create_space", spaces: [{ spaceId: "s-dining", number: "101", name: "Dining", levelId: L1, outline: rect(0, 0, 30 * FT, 20 * FT), origin: { kind: "traced", underlayId: "u-a101" } }] });
    expect(traceTooEarly.message).toMatch(/isn't calibrated yet.*Set its scale first/);

    m.ok({ type: "calibrate_underlay", underlayId: "u-a101", calibration: { method: "stated_scale", scale: `1/8" = 1'-0"` } });
    const cal = m.underlay("u-a101").calibration;
    if (!cal) throw new Error("calibration missing");
    // A 270 pt line on a 1/8" sheet is 30 feet.
    expect(270 * cal.mmPerUnit).toBeCloseTo(30 * FT, 6);

    // The person clicks on the page; the tool maps each click to the model.
    const page = (pts: ReadonlyArray<{ x: number; y: number }>) => pts.map((p) => sourceToModel(cal, p));
    m.ok({
      type: "create_space",
      spaces: [
        { spaceId: "s-dining", number: "101", name: "Dining", levelId: L1, outline: page(rect(100, 100, 270, 180)), origin: { kind: "traced", underlayId: "u-a101" }, use: DINING },
        { spaceId: "s-kitchen", number: "102", name: "Kitchen", levelId: L1, outline: page(rect(370, 100, 180, 135)), origin: { kind: "traced", underlayId: "u-a101" }, use: KITCHEN },
      ],
    });

    const dining = m.space("s-dining");
    expect(dining.origin).toEqual({ kind: "traced", underlayId: "u-a101" });
    expect((spaceAreaM2(m.head.elements, dining) ?? 0) * FT2_PER_M2).toBeCloseTo(600, 3);
    expect(designOccupants(dining, spaceAreaM2(m.head.elements, dining))).toEqual({ value: 42, basis: "use_default" });

    // A schedule lists both spaces with area and occupants.
    const registry = fieldProviderRegistry();
    const printed = evaluateScheduleV2(buildRowSet(m.head, SPACE_SCHEDULE, { viewId: "v-spaces", revision: 1, registry }), SPACE_SCHEDULE);
    const text = JSON.stringify(printed.rows);
    expect(text).toMatch(/101.*Dining.*600.*42/);
    expect(text).toMatch(/102.*Kitchen.*300.*6/);

    // Area loads: ASHRAE 62.1 Vbz = Rp·Pz + Ra·Az on Dining = 7.5 × 42 + 0.18 × 600 = 423 cfm; lighting 1.5 VA/ft² = 900 VA.
    const load = densityLoad(m.head.elements, asElementId("s-dining"));
    expect(load?.bag.cfm).toBeCloseTo(423, 3);
    expect(load?.bag.va).toBeCloseTo(900, 3);
    expect(densityLoad(m.head.elements, asElementId("s-kitchen"))?.bag.cfm).toBeCloseTo(81, 3);
  });

  it("calibrates from two picked points and a typed distance, and keeps the underlay still once locked", () => {
    const m = new Model(emptyModel());
    m.ok({ type: "place_underlay", underlayId: "u", levelId: L1, source: { format: "image", provider: "host.workspace", ref: "f", name: "scan.png" } });
    expect(m.refused({ type: "calibrate_underlay", underlayId: "u", calibration: { method: "stated_scale", scale: `1/4" = 1'-0"` } }).message).toMatch(/pixels make an inch/);
    m.ok({ type: "calibrate_underlay", underlayId: "u", calibration: { method: "two_points", a: { x: 10, y: 10 }, b: { x: 490, y: 10 }, distanceMm: 24 * FT } });
    expect(m.underlay("u").calibration?.mmPerUnit).toBeCloseTo((24 * FT) / 480, 9);
    m.ok({ type: "edit_underlay", underlayId: "u", opacityPct: 35, locked: true });
    expect(m.refused({ type: "edit_underlay", underlayId: "u", modelAt: { x: 1000, y: 0 } }).message).toMatch(/locked.*Unlock it first/);
    expect(m.refused({ type: "calibrate_underlay", underlayId: "u", calibration: { method: "two_points", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, distanceMm: 100 } }).message).toMatch(/locked/);
    m.ok({ type: "edit_underlay", underlayId: "u", hidden: true });
    expect(m.refused({ type: "create_space", spaces: [{ spaceId: "s", number: "1", name: "A", levelId: L1, outline: rect(0, 0, 3000, 3000), origin: { kind: "traced", underlayId: "u" } }] }).message).toMatch(/hidden/);
  });

  it("reads printed scales the way sheets write them", () => {
    expect(parseDrawingScale(`1/8" = 1'-0"`)).toBe(96);
    expect(parseDrawingScale(`3/16"=1'-0"`)).toBeCloseTo(64, 9);
    expect(parseDrawingScale(`1/4" = 1'`)).toBe(48);
    expect(parseDrawingScale(`1" = 20'`)).toBe(240);
    expect(parseDrawingScale("1:100")).toBe(100);
    expect(parseDrawingScale("about an eighth")).toBeNull();
  });
});

describe("spaces", () => {
  it("refuses outlines no one means, and duplicate numbers on a level", () => {
    const m = new Model(emptyModel());
    expect(m.refused({ type: "create_space", spaces: [{ spaceId: "s", number: "1", name: "A", levelId: L1, outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }] }).message).toMatch(/almost no floor/);
    expect(m.refused({ type: "create_space", spaces: [{ spaceId: "s", number: "1", name: "A", levelId: L1, outline: [{ x: 0, y: 0 }, { x: 3000, y: 3000 }, { x: 3000, y: 0 }, { x: 0, y: 3000 }] }] }).message).toMatch(/crosses itself/);
    m.ok({ type: "create_space", spaces: [{ spaceId: "s1", number: "101", name: "Office", levelId: L1, outline: rect(0, 0, 3000, 3000) }] });
    expect(m.refused({ type: "create_space", spaces: [{ spaceId: "s2", number: "101", name: "Office B", levelId: L1, outline: rect(5000, 0, 3000, 3000) }] }).message).toMatch(/Space 101 already exists/);
  });

  it("types a space into the table first, then draws it; area comes only from the outline", () => {
    const m = new Model(emptyModel());
    m.ok({ type: "create_space", spaces: [{ spaceId: "s1", number: "105", name: "Storage" }] });
    expect(m.space("s1").bounds).toEqual({ kind: "none" });
    expect(m.space("s1").origin).toEqual({ kind: "typed" });
    expect(plannedSpaces(m.head.elements).map((s) => s.id)).toEqual(["s1"]);
    expect(spaceAreaM2(m.head.elements, m.space("s1"))).toBeNull();
    m.ok({ type: "edit_space", spaceId: "s1", levelId: L1, outline: rect(0, 0, 10 * FT, 12 * FT), occupants: 2 });
    expect(m.space("s1").origin).toEqual({ kind: "drawn" });
    expect(plannedSpaces(m.head.elements)).toEqual([]);
    expect((spaceAreaM2(m.head.elements, m.space("s1")) ?? 0) * FT2_PER_M2).toBeCloseTo(120, 6);
    expect(m.summary.join(" ")).toMatch(/120 sq ft.*2 occupants/);
    m.ok({ type: "edit_space", spaceId: "s1", occupants: null });
    expect(m.space("s1").occupants).toBeUndefined();
  });

  it("makes one space per room in one command, follows the room's area, and never doubles a room", () => {
    const room = (id: string, number: string, name: string, w: number): BimElement => ({ id: asElementId(id), kind: "room", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" }, number, name, outline: rect(0, 0, w, 4000), areaSqM: (w * 4000) / 1e6 });
    const m = new Model(emptyModel([room("r1", "101", "Lobby", 5000), room("r2", "102", "Office", 3000)]));
    m.ok({ type: "make_spaces_from_rooms", levelId: L1 });
    expect(m.summary).toEqual(["Made 2 spaces from rooms"]);
    const lobby = m.space(spaceIdForRoom("r1"));
    expect(lobby).toMatchObject({ number: "101", name: "Lobby", levelId: L1, bounds: { kind: "rooms", roomIds: ["r1"] }, origin: { kind: "from_room", roomId: "r1" } });
    expect(spaceAreaM2(m.head.elements, lobby)).toBeCloseTo(20, 9);
    expect(m.refused({ type: "make_spaces_from_rooms", levelId: L1 }).message).toMatch(/Every room already has a space/);
  });

  it("refuses to delete a space that carries an area load, so the estimate isn't lost", () => {
    const m = new Model(emptyModel());
    m.ok({ type: "create_space", spaces: [{ spaceId: "s1", number: "1", name: "Kitchen", levelId: L1, outline: rect(0, 0, 4000, 4000) }] });
    const load: BimElement = { id: asElementId("load-k"), kind: "load_point", version: 1, authoredRev: {}, host: { elementId: asElementId("none"), port: "start" }, connectionType: "", values: { va: 5000 }, anchor: { kind: "space", id: asElementId("s1") } };
    m.head = { ...m.head, elements: { ...m.head.elements, [load.id]: load } };
    expect(m.refused({ type: "delete_spaces", spaceIds: ["s1"] })).toMatchObject({ code: "in_use", message: expect.stringMatching(/1 load is spread over this space/) });
  });
});

describe("zones", () => {
  function twoSpaces(): Model {
    const m = new Model(emptyModel());
    const rtu = (id: string, mark: string): BimElement => ({ id: asElementId(id), kind: "equipment", version: 1, authoredRev: {}, mark, position: { x: 0, y: 0 }, portOffset: { x: 0, y: 0 } } as BimElement);
    m.head = { ...m.head, elements: { ...m.head.elements, rtu1: rtu("rtu1", "RTU-1"), rtu2: rtu("rtu2", "RTU-2") } };
    m.ok({
      type: "create_space",
      spaces: [
        { spaceId: "dining", number: "101", name: "Dining", levelId: L1, outline: rect(0, 0, 9000, 6000) },
        { spaceId: "kitchen", number: "102", name: "Kitchen", levelId: L1, outline: rect(9000, 0, 6000, 4500) },
      ],
    });
    return m;
  }

  it("makes a zone from selected spaces and assigns it to equipment (RTU-2 serves Zone 2 Kitchen)", () => {
    const m = twoSpaces();
    m.ok({ type: "create_zone", zoneId: "z1", name: "Zone 1 Dining", purpose: "thermal", spaceIds: ["dining"], servedBy: "rtu1" });
    m.ok({ type: "create_zone", zoneId: "z2", name: "Zone 2 Kitchen", purpose: "thermal", spaceIds: ["kitchen"], servedBy: "rtu2" });
    expect(m.summary).toEqual(["Made thermal zone Zone 2 Kitchen with 1 space, served by RTU-2"]);
    expect(zonesServedBy(m.head.elements, asElementId("rtu2")).map((z) => z.name)).toEqual(["Zone 2 Kitchen"]);
    expect(zonesOfSpace(m.head.elements, asElementId("kitchen")).map((z) => z.id)).toEqual(["z2"]);
    expect(m.refused({ type: "create_zone", zoneId: "z3", name: "Bad", purpose: "thermal", servedBy: "kitchen" }).message).toMatch(/a zone is served by equipment/);
  });

  it("moves a space out of its old zone of the same purpose instead of putting it in two thermal zones", () => {
    const m = twoSpaces();
    m.ok({ type: "create_zone", zoneId: "z1", name: "Zone 1", purpose: "thermal", spaceIds: ["dining", "kitchen"] });
    m.ok({ type: "create_zone", zoneId: "vent", name: "Kitchen exhaust", purpose: "ventilation", spaceIds: ["kitchen"] });
    m.ok({ type: "create_zone", zoneId: "z2", name: "Zone 2", purpose: "thermal", spaceIds: ["kitchen"] });
    expect(m.zone("z1").spaceIds).toEqual(["dining"]);
    expect(m.zone("vent").spaceIds).toEqual(["kitchen"]);
    expect(spacesOfZone(m.head.elements, asElementId("z2")).map((s) => s.id)).toEqual(["kitchen"]);
    m.ok({ type: "delete_spaces", spaceIds: ["kitchen"] });
    expect(m.zone("z2").spaceIds).toEqual([]);
  });
});

describe("space locator (k2's spaceOf) and incremental index", () => {
  it("answers which space a point, a placed part or a run-end load is in, and a planned part by its space hint", () => {
    const m = new Model(emptyModel());
    m.ok({ type: "create_space", spaces: [{ spaceId: "a", number: "1", name: "A", levelId: L1, outline: rect(0, 0, 10_000, 10_000) }, { spaceId: "b", number: "2", name: "B", levelId: L1, outline: rect(2000, 2000, 2000, 2000) }] });
    // Overlapping: the smaller (more specific) space wins.
    expect(spaceAt(m.head.elements, L1, { x: 3000, y: 3000 })?.id).toBe("b");
    expect(spaceAt(m.head.elements, L1, { x: 8000, y: 8000 })?.id).toBe("a");
    expect(spaceAt(m.head.elements, L1, { x: 20_000, y: 0 })).toBeNull();
    const part = { id: asElementId("p1"), kind: "part", version: 1, authoredRev: {}, typeId: asElementId("t"), levelId: L1, position: { x: 9000, y: 9000 }, offsetMm: 0, rotationDeg: 0, mark: "WH-1", values: {} } as BimElement;
    const planned = { ...part, id: asElementId("p2"), planned: { spaceHint: asElementId("b") } } as BimElement;
    const pointLoad: BimElement = { id: asElementId("lp1"), kind: "load_point", version: 1, authoredRev: {}, host: { elementId: asElementId("x"), port: "start" }, connectionType: "", values: {}, anchor: { kind: "point", levelId: L1, position: { x: 2500, y: 2500 } } };
    const elements = { ...m.head.elements, p1: part, p2: planned, lp1: pointLoad };
    expect(spaceOf(elements, asElementId("p1"))?.id).toBe("a");
    expect(spaceOf(elements, asElementId("p2"))?.id).toBe("b");
    expect(spaceOf(elements, asElementId("lp1"))?.id).toBe("b");
    expect(spaceOf(elements, { levelId: L1, point: { x: 1, y: 1 } })?.id).toBe("a");
  });

  it("re-measures only the space an edit changed, and re-evaluates density only when area, use or occupants change", () => {
    const m = new Model(emptyModel());
    const many = Array.from({ length: 50 }, (_, i) => ({ spaceId: `s${i}`, number: `${100 + i}`, name: `Room ${i}`, levelId: L1, outline: rect((i % 10) * 6000, Math.floor(i / 10) * 6000, 5000, 5000), use: DINING }));
    m.ok({ type: "create_space", spaces: many });
    const before = spaceIndexStats(m.head.elements).measured;
    expect(spacesOnLevel(m.head.elements, L1)).toHaveLength(50);
    m.ok({ type: "edit_space", spaceId: "s7", name: "Renamed" });
    expect(spaceIndexStats(m.head.elements).measured - before).toBe(1);

    densityLoad(m.head.elements, asElementId("s3"));
    const evaluated = densityEvaluationCount();
    m.ok({ type: "edit_space", spaceId: "s3", name: "Bar" });
    densityLoad(m.head.elements, asElementId("s3"));
    expect(densityEvaluationCount()).toBe(evaluated);
    m.ok({ type: "edit_space", spaceId: "s3", occupants: 10 });
    expect(densityLoad(m.head.elements, asElementId("s3"))?.bag.cfm).toBeCloseTo(7.5 * 10 + 0.18 * FT2_PER_M2 * 25, 6);
    expect(densityEvaluationCount()).toBe(evaluated + 1);
  });
});

describe("through the command path every client uses", () => {
  const NOW = () => "2026-10-27T18:00:00.000Z";

  it("parses, commits and undoes as one step (before: every space command was refused as not a space command)", () => {
    let head = emptyModel();
    const log: Changeset[] = [];
    let seq = 0;
    const submit = (command: Command) => {
      const parsed = commandSchema.safeParse(command);
      expect(parsed.success).toBe(true);
      const d = planCommit(head, [], { idempotencyKey: `k-${++seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW, log);
      if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
      expect(canonicalJson(applyChangeset(head, d.changeset))).toBe(canonicalJson(d.model));
      head = d.model;
      log.push(d.changeset);
      return d.changeset;
    };
    const draw: Command = { type: "create_space", spaces: [{ spaceId: "s1", number: "101", name: "Dining", levelId: L1, outline: rect(0, 0, 9000, 6000), use: DINING }] };
    const preview = executeCommand(head, draw);
    expect(preview.ok && preview.summary).toEqual(["Drew space 101 Dining (581 sq ft)"]);
    submit(draw);
    submit({ type: "edit_space", spaceId: "s1", name: "Dining room" });
    submit({ type: "undo", revision: log[1]?.revision ?? 0 });
    expect(head.elements.s1?.kind === "space" && head.elements.s1.name).toBe("Dining");
    expect(modelSpaceLocator(head.elements).measureOf(asElementId("s1"))).toEqual({ areaSqM: 54, occupants: 41 });
  });
});
