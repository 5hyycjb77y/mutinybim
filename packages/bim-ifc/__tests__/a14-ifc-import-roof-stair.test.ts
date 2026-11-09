/**
 * @jest-environment node
 *
 * Round 14 lane A14: roofs and stairs come in from IFC through the
 * Architecture add-on's `kernel.ifc_import_rule` rows. Round trip from round
 * 13's kinds: a roof on Level 2 and a 23-riser stair on Level 1 are built by
 * commands, their bodies (the kind rows' `solid` blocks) written as IFC
 * extrusions in their storeys, and read back: the roof keeps its footprint,
 * thickness and height above its level; the stair comes back as the same
 * straight run (foot, top, width, risers) and climbs to the level above. A
 * roof whose body isn't flat pieces, or a stair that doesn't climb in one
 * line, stays linked with the reason.
 *
 * (Round 13's exporter writes no body for an add-on kind, so the blocks are
 * written here the way its prisms are; see A14-notes, coordinator line 9.)
 *
 * Fails on round 13's code: there was no rule, so both stayed on the linked
 * model ("Roofs can't be edited here yet", "Stairs can't be edited here yet").
 */
import { asRoof, asStair, ROOF_KIND_ROW, STAIR_KIND_ROW, stairGeometry } from "@permitzip/bim-pack-architecture";
import { asElementId, GLOBAL_PARTITION, type BimElement, type ImportExtrusion, type ImportProduct, type ImportRuleContext, type KindSolidShape, type Level } from "@permitzip/bim-kernel";
import { ROOF_IMPORT_RULE, STAIR_IMPORT_RULE } from "../../bim-pack-architecture/src/import";
import { importIfc } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { hostModel, IfcText } from "./i9-fixtures";

const LEVELS = [
  { id: "L1", name: "Level 1", elevationMm: 0 },
  { id: "L2", name: "Level 2", elevationMm: 4000 },
];

/** A kind row's body as one IFC product in its storey: each block an outline pushed up from its bottom. */
function writeBody(t: IfcText, storey: string, storeyZ: number, entity: string, name: string, shape: KindSolidShape | null, predefined: string): void {
  if (shape?.form !== "prisms") throw new Error(`${name} has no blocks`);
  const items = shape.blocks.map((b) => t.extrude(t.polygon(b.outline.map((p) => [p.x, p.y] as const)), b.z1 - b.z0, t.axis3([0, 0, b.z0 - storeyZ])));
  t.product(storey, entity, name, [0, 0, 0], t.body(items), predefined);
}

function roundTrip() {
  const m = twoLevels("a14-roof-stair");
  m.ok({ type: "create_element", elementId: "r", kind: "architecture.roof", levelId: "L2", placement: { kind: "area", outline: [{ x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 10_000, y: 8000 }, { x: 0, y: 8000 }] } });
  m.ok({ type: "create_element", elementId: "s", kind: "architecture.stair", levelId: "L1", placement: { kind: "line", start: { x: 1000, y: 2000 }, end: { x: 7160, y: 2000 } } });
  const els = m.head.elements;
  const t = IfcText.start();
  t.storey("Level 1", 0);
  t.storey("Level 2", 4000);
  const roof = els["r"];
  const stair = els["s"];
  if (!roof || !stair) throw new Error("not drawn");
  writeBody(t, "Level 2", 4000, "IFCROOF", "Roof", ROOF_KIND_ROW.solid?.(roof, { elements: els, floorMm: 4000 }) ?? null, ".FLAT_ROOF.");
  writeBody(t, "Level 1", 0, "IFCSTAIR", "Stair", STAIR_KIND_ROW.solid?.(stair, { elements: els, floorMm: 0 }) ?? null, ".STRAIGHT_RUN_STAIR.");
  const host = hostModel(LEVELS);
  const plan = importIfc(t.text(), { model: host, referenceId: "ref", sourceKey: "v1", sourceId: "ver-1", label: "Round trip", disciplines: ["architecture"] });
  return { plan, host };
}

const ofKind = (records: readonly BimElement[], kind: string): BimElement[] => records.filter((r) => r.kind === kind);

describe("a14 ifc import roof and stair", () => {
  it("the roof comes back with its footprint, thickness and height above Level 2", () => {
    const { plan } = roundTrip();
    const [record, ...more] = ofKind(plan.records, "architecture.roof");
    expect(more).toEqual([]);
    const roof = record ? asRoof(record) : null;
    if (!roof) throw new Error("no roof record");
    expect(roof).toMatchObject({ levelId: "L2", thicknessMm: 250, baseOffsetMm: 0 });
    const xs = roof.outline.map((p) => p.x);
    const ys = roof.outline.map((p) => p.y);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0, 10_000, 0, 8000]);
    expect(Reflect.get(record ?? {}, "provenance")).toMatchObject({ source: "ver-1" });
    expect(plan.report.classes.find((c) => c.classId === "arch.roof")).toMatchObject({ converted: 1, linked: [] });
  });

  it("the stair comes back as the same run with its risers and climbs to the level above", () => {
    const { plan, host } = roundTrip();
    const [record] = ofKind(plan.records, "architecture.stair");
    const stair = record ? asStair(record) : null;
    if (!stair) throw new Error("no stair record");
    expect(stair).toMatchObject({ levelId: "L1", start: { x: 1000, y: 2000 }, end: { x: 7160, y: 2000 }, widthMm: 1100, risers: 23 });
    const g = stairGeometry(stair, host.elements);
    expect(g).toMatchObject({ topLevelId: "L2", risers: 23, treads: 22 });
    expect(g?.treadMm).toBeCloseTo(280, 3);
    expect(plan.report.classes.find((c) => c.classId === "arch.stair")).toMatchObject({ converted: 1, linked: [] });
  });

  it("a roof that isn't flat pieces and a stair that doesn't climb in a line stay linked, each with its reason", () => {
    const level = { id: asElementId("L1"), kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 } as Level;
    const ctx: ImportRuleContext = {
      cls: { id: "arch.roof", label: "Roofs", discipline: "architecture" } as ImportRuleContext["cls"],
      fields: {},
      options: {},
      idFor: (id) => asElementId(`imp-${id}`),
      level: () => level,
      partition: () => GLOBAL_PARTITION,
      converted: () => null,
      group: () => null,
      shared: (_key, make) => make(),
      values: () => ({}),
      provenance: (p) => ({ ifcGlobalId: p.sourceId, source: "ver-1" }),
      note: () => {},
    };
    const box = (x0: number, z0: number, h: number, lean = 0): ImportExtrusion => ({ base: [{ x: x0, y: 0, z: z0 }, { x: x0 + 280, y: 0, z: z0 + lean }, { x: x0 + 280, y: 1100, z: z0 + lean }, { x: x0, y: 1100, z: z0 }], along: { x: 0, y: 0, z: h } });
    const product = (entity: string, extrusions: readonly ImportExtrusion[]): ImportProduct => ({ sourceId: "g1", entity, predefinedType: null, objectType: null, name: "X", longName: null, tag: null, storeyId: null, typeId: null, typeName: null, hostId: null, groupIds: [], geometry: { extrusions, bounds: null, unread: null }, properties: {}, overall: { width: null, height: null }, material: null, ports: [] });
    expect(ROOF_IMPORT_RULE.convert(product("IfcRoof", [box(0, 4000, 250, 600)]), ctx)).toEqual({ ok: false, reason: "its roof isn't made of flat pieces (a sloped or curved surface)" });
    expect(ROOF_IMPORT_RULE.convert(product("IfcRoof", []), ctx)).toEqual({ ok: false, reason: "it has no roof body of its own to read" });
    // Two steps side by side at the same place in plan: no line to climb along.
    expect(STAIR_IMPORT_RULE.convert(product("IfcStair", [box(0, 0, 178), box(0, 0, 356)]), ctx)).toEqual({ ok: false, reason: "its steps don't climb in one straight line" });
    // Two steps climbing east: the foot is the low one, risers = steps + 1.
    const ok = STAIR_IMPORT_RULE.convert(product("IfcStair", [box(0, 0, 178), box(280, 0, 356)]), ctx);
    expect(ok.ok && ok.records[0] ? asStair(ok.records[0]) : null).toMatchObject({ start: { x: 0, y: 550 }, end: { x: 560, y: 550 }, widthMm: 1100, risers: 3 });
  });
});
