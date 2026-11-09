/**
 * @jest-environment node
 *
 * Spatial: clearance zones on parts (type zones, per-part changes, never
 * solid, dashed in plans, moving and turning with the part) and hosts (a part
 * stands on one of our slabs or a linked roof, on a curb; deleting the deck
 * leaves it with no host).
 */
import {
  DEFAULT_SETTINGS,
  applyChangeset,
  builtinPartType,
  canonicalJson,
  commandSchema,
  buildViewScene,
  executeCommand,
  hostState,
  partClearances,
  partFootprint,
  planCommit,
  type Changeset,
  type ClearanceZone,
  type Command,
  type CommandRequest,
  type LibraryEntry,
  type ModelState,
  type PartInstance,
  type PartTypeElement,
  type Slab,
  type Vec2,
} from "../src";
import { CLEARANCE_DASH, drawPartClearances } from "../src/drawing/runs";
import { elementSolid } from "../src/drawing/solids";

const FT = 304.8;
const IN = 25.4;
const NOW = () => "2026-10-23T00:00:00.000Z";

function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
const RTU = lib("builtin:rtu-5-ton@1");

let counter = 0;
function request(base: number, command: Command): CommandRequest {
  counter += 1;
  return { idempotencyKey: `k-${counter}`, baseRevision: base, actor: { id: "priya", name: "Priya", kind: "human" }, command, clientSessionId: "tab" };
}

const ROOF_FT = 26.5;
const deck: Slab = {
  id: "deck-1" as Slab["id"],
  kind: "slab",
  version: 1,
  authoredRev: {},
  partition: { level: "ROOF", zone: "Z1", discipline: "architecture" },
  outline: [
    { x: -20 * FT, y: -20 * FT },
    { x: 60 * FT, y: -20 * FT },
    { x: 60 * FT, y: 40 * FT },
    { x: -20 * FT, y: 40 * FT },
  ],
  thickness: 8 * IN,
};

class Model {
  head: ModelState = { modelId: "spatial", revision: 0 as ModelState["revision"], elements: { [deck.id]: deck }, connections: [], settings: DEFAULT_SETTINGS };
  readonly log: Changeset[] = [];
  submit(command: Command) {
    const parsed = commandSchema.parse(command);
    const decision = planCommit(this.head, [], request(this.head.revision, parsed), NOW, this.log);
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
  refused(command: Command): string {
    const d = this.submit(command);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    return d.error.message;
  }
  part(id: string): PartInstance {
    const el = this.head.elements[id];
    if (el?.kind !== "part") throw new Error(`missing part ${id}`);
    return el;
  }
  type(): PartTypeElement {
    const el = this.head.elements[RTU.id];
    if (el?.kind !== "part_type") throw new Error("missing RTU type");
    return el;
  }
}

function withRoofAndUnit(): Model {
  const m = new Model();
  m.ok({ type: "create_level", levelId: "l1", name: "Level 1", elevationMm: 0 });
  m.ok({ type: "create_level", levelId: "roof", name: "ROOF", elevationMm: ROOF_FT * FT });
  m.ok({ type: "place_part", partId: "rtu-1", typeId: RTU.id, partType: RTU.definition, levelId: "roof", position: { x: 10 * FT, y: 10 * FT }, offsetMm: 2 * FT, mark: "RTU-1" });
  return m;
}

const SERVICE: ClearanceZone = { id: "service", name: "Service access", purpose: "service_access", face: "front", depth: 4 * FT };
const ECONOMIZER: ClearanceZone = { id: "economizer", name: "Economizer access", purpose: "economizer_access", face: "back", depth: 3 * FT, offset: 1 * FT };

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01);

describe("clearance zones on a part type", () => {
  it("sit against their face, move and turn with the part, and are never part of its body", () => {
    const m = withRoofAndUnit();
    const footprintBefore = partFootprint(m.type(), m.part("rtu-1"));
    m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [SERVICE, ECONOMIZER] });
    expect(partFootprint(m.type(), m.part("rtu-1"))).toEqual(footprintBefore);

    const [service, economizer] = partClearances(m.head, m.part("rtu-1"));
    if (!service || !economizer) throw new Error("expected two zones");
    const front = Math.max(...footprintBefore.map((p) => p.x));
    const back = Math.min(...footprintBefore.map((p) => p.x));
    // Facing east: the service zone reaches 4 ft east of the unit's front.
    near(Math.min(...service.corners.map((c) => c.x)), front);
    near(Math.max(...service.corners.map((c) => c.x)), front + 4 * FT);
    // The economizer zone is behind it and slid 1 ft toward the unit's left (north), not centred.
    near(Math.max(...economizer.corners.map((c) => c.x)), back);
    const centreY = (Math.min(...footprintBefore.map((p) => p.y)) + Math.max(...footprintBefore.map((p) => p.y))) / 2;
    near((Math.min(...economizer.corners.map((c) => c.y)) + Math.max(...economizer.corners.map((c) => c.y))) / 2, centreY + 1 * FT);

    m.ok({ type: "move_elements", ids: ["rtu-1"], delta: { x: 5 * FT, y: 0 } });
    near(Math.max(...(partClearances(m.head, m.part("rtu-1"))[0]?.corners.map((c) => c.x) ?? [])), front + 9 * FT);

    m.ok({ type: "rotate_elements", ids: ["rtu-1"], angleDeg: 90 });
    const turned = partClearances(m.head, m.part("rtu-1"))[0];
    if (!turned) throw new Error("zone gone after turning");
    // Now facing north: the zone is north of the unit.
    expect(Math.min(...turned.corners.map((c) => c.y))).toBeGreaterThan(m.part("rtu-1").position.y);
  });

  it("each placed part can change, switch off or add a zone; undo puts it back", () => {
    const m = withRoofAndUnit();
    m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [SERVICE] });
    m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "instance", overrides: { service: { depth: 6 * FT }, combustible: { name: "To combustibles", purpose: "combustible", face: "left", depth: 1 * FT } } });
    const zones = partClearances(m.head, m.part("rtu-1"));
    expect(zones.map((z) => [z.id, z.overridden])).toEqual([["service", true], ["combustible", true]]);
    near((zones[0]?.max[0] ?? 0) - (zones[0]?.min[0] ?? 0), 6 * FT);

    const off = m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "instance", overrides: { service: { off: true } } });
    expect(partClearances(m.head, m.part("rtu-1")).map((z) => z.id)).toEqual(["combustible"]);

    expect(m.refused({ type: "set_part_clearances", id: "rtu-1", scope: "instance", overrides: { mystery: { depth: 100 } } })).toMatch(/no clearance "mystery"/);
    m.ok({ type: "undo", revision: off.revision });
    expect(partClearances(m.head, m.part("rtu-1")).map((z) => z.id)).toEqual(["service", "combustible"]);
  });

  it("refuses a command with a field it doesn't know, instead of dropping it", () => {
    expect(commandSchema.safeParse({ type: "set_part_host", ids: ["rtu-1"], host: null, curb: 14 }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [{ ...SERVICE, depthFt: 4 }] }).success).toBe(false);
  });

  it("draws each zone dashed and named in plan", () => {
    const m = withRoofAndUnit();
    m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [SERVICE] });
    const lines: Array<{ a: Vec2; b: Vec2; dash?: number[] }> = [];
    const texts: string[] = [];
    drawPartClearances(m.head, m.part("rtu-1"), (a, b, _pen, dash) => lines.push({ a, b, ...(dash ? { dash } : {}) }), (_at, text) => texts.push(text));
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => canonicalJson(l.dash ?? null) === canonicalJson([...CLEARANCE_DASH]))).toBe(true);
    expect(texts).toEqual(["SERVICE ACCESS"]);
  });
});

describe("clearance zones on drawings", () => {
  it("a floor plan of the roof draws the zone dashed and named, and moves it with the unit", () => {
    const m = withRoofAndUnit();
    m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [SERVICE] });
    m.ok({ type: "create_view", viewId: "v-roof", name: "Roof plan", viewType: "floor_plan", crop: { min: { x: -10 * FT, y: -10 * FT }, max: { x: 50 * FT, y: 40 * FT } }, props: { level: "ROOF", scale: 48 } });
    const dashed = (scene: ReturnType<typeof buildViewScene>["scene"]) => scene.primitives.filter((p) => p.kind === "line" && canonicalJson(p.dash ?? null) === canonicalJson([3, 1.5]));
    const first = buildViewScene(m.head, "v-roof").scene;
    expect(dashed(first)).toHaveLength(4);
    expect(first.primitives.some((p) => p.kind === "text" && p.text === "SERVICE ACCESS")).toBe(true);
    m.ok({ type: "move_elements", ids: ["rtu-1"], delta: { x: 5 * FT, y: 0 } });
    const moved = buildViewScene(m.head, "v-roof").scene;
    const xs = (scene: typeof first) => dashed(scene).flatMap((p) => (p.kind === "line" ? [p.a.x, p.b.x] : []));
    expect(Math.min(...xs(moved))).toBeGreaterThan(Math.min(...xs(first)));
  });
});

describe("hosts", () => {
  it("seats a part on our slab plus its curb, shows the curb as a solid, and notices when it floats", () => {
    const m = withRoofAndUnit();
    const piecesBefore = elementSolid(m.head, m.part("rtu-1"), 0)?.pieces.length ?? 0;
    m.ok({ type: "set_part_host", ids: ["rtu-1"], host: { kind: "slab", elementId: "deck-1" }, curbMm: 14 * IN });
    expect(m.part("rtu-1").offsetMm).toBeCloseTo(14 * IN, 3);
    expect(hostState(m.head, m.part("rtu-1"))).toMatchObject({ status: "seated", label: 'Stands on slab deck-1 on ROOF on a 14" curb' });
    expect(elementSolid(m.head, m.part("rtu-1"), 0)?.pieces.length).toBe(piecesBefore + 1);

    m.ok({ type: "move_elements", ids: ["rtu-1"], delta: { x: 0, y: 0 }, dzMm: 1 * FT });
    expect(hostState(m.head, m.part("rtu-1"))).toMatchObject({ status: "floating", label: expect.stringMatching(/^12" above slab deck-1/) });
  });

  it("deleting the deck keeps the parts on it, says their host is gone, and undo puts it back", () => {
    const m = withRoofAndUnit();
    m.ok({ type: "set_part_host", ids: ["rtu-1"], host: { kind: "slab", elementId: "deck-1" } });
    const predicted = executeCommand(m.head, { type: "delete_elements", ids: ["deck-1"], policy: "refuse" });
    expect(predicted.ok ? predicted.summary?.join(" ") : "").toMatch(/1 part stood on it and now has nothing under it/);
    const cs = m.ok({ type: "delete_elements", ids: ["deck-1"], policy: "refuse" });
    expect(m.part("rtu-1").host).toEqual({ kind: "slab", elementId: "deck-1" });
    expect(hostState(m.head, m.part("rtu-1"))).toMatchObject({ status: "missing", label: "Its host slab deck-1 (deleted) is gone" });
    m.ok({ type: "undo", revision: cs.revision });
    expect(hostState(m.head, m.part("rtu-1")).status).toBe("seated");
  });

  it("stands a part on a linked roof at the picked height, and refuses a slab that isn't there", () => {
    const m = withRoofAndUnit();
    const roofTop = ROOF_FT * FT + 6 * IN;
    m.ok({ type: "set_part_host", ids: ["rtu-1"], host: { kind: "linked", referenceId: "ref-arch", globalId: "2Fq0roof", name: "Roof deck", surface: "roof", topMm: roofTop }, curbMm: 18 * IN });
    expect(m.part("rtu-1").offsetMm).toBeCloseTo(6 * IN + 18 * IN, 3);
    expect(hostState(m.head, m.part("rtu-1")).label).toBe('Stands on Roof deck (linked) on a 18" curb');
    expect(m.refused({ type: "set_part_host", ids: ["rtu-1"], host: { kind: "slab", elementId: "nope" } })).toMatch(/no slab nope/);
    m.ok({ type: "set_part_host", ids: ["rtu-1"], host: null, curbMm: null });
    expect(m.part("rtu-1")).not.toHaveProperty("host");
    expect(m.part("rtu-1")).not.toHaveProperty("curbMm");
  });

  it("measures working space from the floor the part stands on", () => {
    const m = withRoofAndUnit();
    const floorZone: ClearanceZone = { ...SERVICE, id: "ws", purpose: "working_space", fromFloor: true, height: 6.5 * FT };
    m.ok({ type: "set_part_clearances", id: "rtu-1", scope: "type", zones: [floorZone] });
    const z = partClearances(m.head, m.part("rtu-1"))[0];
    near(z?.bottomMm ?? 0, ROOF_FT * FT);
    near(z?.topMm ?? 0, ROOF_FT * FT + 6.5 * FT);
  });
});

