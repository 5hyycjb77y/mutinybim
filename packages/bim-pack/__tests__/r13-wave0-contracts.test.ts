/**
 * @jest-environment node
 *
 * Round 13 wave 0: the contracts lanes K13, A13a, A13b, E13, M13 and P13
 * build against (contract 1.11.0). Each new point is known to the
 * conformance suite at version 1, refuses malformed rows in words, and is
 * readable by an add-on that isn't first-party with no kernel edit. Nested
 * spaces (product decision, Nov 3: sub-rooms inside a parent room) are built here
 * because every lane reads them. Behaviour the lanes own refuses with
 * "isn't built yet".
 *
 * Fails on round 12's code: none of these points, shapes or readers exist,
 * and the contract is 1.10.0.
 */
import {
  BOUNDING_ELEMENT_POINT,
  CONNECTION_FIELD_POINT,
  CONNECTOR_FACE_POINT,
  DATUM_POINT,
  ELEMENT_KIND_POINT,
  GRAVITY_OUTFALL_POINT,
  HOST_VOID_POINT,
  IFC_RELATION_POINT,
  KNOWN_POINTS,
  LINE_JOIN_POINT,
  PACK_CONTRACT_VERSION,
  PackSet,
  boundsRooms,
  childrenOf,
  connectionFieldValue,
  connectorFacesOf,
  contribute,
  datumSnapLines,
  definePack,
  diagramEntriesOf,
  faceOfSide,
  ifcRelationRowsFor,
  isPackRefusal,
  lookupTable,
  modelIdsOf,
  nestedRows,
  nestingRefusal,
  outfallOf,
  parentOf,
  pointOnFace,
  runPackConformance,
  withPackSet,
  type ConnectorFaceDef,
  type NestedRecord,
  type Pack,
} from "../src";
import { ELEMENT_KINDS, SPACES_BOUNDED_FEATURE, SPACES_NESTED_FEATURE, SPACES_SEPARATORS_FEATURE, spaceAreaM2, type BimElement, type ElementId, type ModelState, type Space } from "@permitzip/bim-kernel";
import { CLIENT_FEATURES, PROTOCOL_FEATURES, SERVER_FEATURES } from "@permitzip/bim-sync";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { ARCHITECTURE_PACK } from "@permitzip/bim-pack-architecture";
import { FIRST_PARTY_ADDONS } from "@permitzip/bim-first-party";

const TEST_KERNEL = "^1.11.0";

function outside(id: string, contributions: Pack["contributions"]): Pack {
  return definePack({ id, name: id.toUpperCase(), version: "1.0.0", kernel: TEST_KERNEL }, contributions);
}

const model = createDemoModel("r13-wave0");
const base = { version: 1, authoredRev: {} } as const;

function space(id: string, extra: Partial<Space> = {}): Space {
  return { ...base, id: id as ElementId, kind: "space", number: id, name: id, bounds: { kind: "none" }, origin: { kind: "typed" }, ...extra } as Space;
}

describe("r13 wave 0 contracts", () => {
  it("is contract 1.11 or later and the conformance suite knows every new point at version 1", () => {
    const [major, minor] = PACK_CONTRACT_VERSION.split(".").map(Number);
    expect(major === 1 && (minor ?? 0) >= 11).toBe(true);
    const ids = new Map(KNOWN_POINTS.map((p) => [p.id, p.version] as const));
    for (const id of ["kernel.datum", "kernel.line_join", "kernel.host_void", "kernel.bounding_element", "kernel.ifc_relation", "kernel.connector_face", "kernel.connection_field", "kernel.gravity_outfall"]) {
      expect([id, ids.get(id)]).toEqual([id, 1]);
    }
  });

  it("an outside add-on's rows at every new point pass conformance and are read with no kernel edit", () => {
    const face: ConnectorFaceDef = { id: "top", label: "Top", center: [0, 0, 300], normal: [0, 0, 1], alongDir: [1, 0, 0], alongMm: 1000, acrossMm: 400 };
    const pack = outside("zz", [
      contribute(DATUM_POINT, [{ kind: "zz.site_line", label: "Site line", labelOf: () => "S1", snapLines: (el, _e, levelId) => (el.id === "site-1" && levelId === "L1" ? [{ datumId: el.id, label: "S1", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }] : []) }]),
      contribute(LINE_JOIN_POINT, [{ kind: "zz.partition", label: "Partition", styles: ["butt"], line: () => null, priority: () => 1 }]),
      contribute(HOST_VOID_POINT, [{ kind: "zz.skylight", label: "Skylight", hostKinds: ["zz.roof"], voidOf: () => null }]),
      contribute(BOUNDING_ELEMENT_POINT, [{ kind: "zz.partition", label: "Demountable partition", boundsByDefault: true, typeParameterKey: "room_bounding", segments: () => [] }]),
      contribute(IFC_RELATION_POINT, [{ id: "zz.voids", label: "Skylight voids", kinds: ["zz.skylight"], relations: () => ({ objects: [], relations: [] }) }]),
      contribute(CONNECTOR_FACE_POINT, [{ kind: "zz.tray", label: "Tray", faces: () => [face] }]),
      contribute(CONNECTION_FIELD_POINT, [{ id: "zz.rated_load", label: "Rated load", key: "zzRatedLoad", valueType: "number", unit: "W", defaultValue: 0 }]),
      contribute(GRAVITY_OUTFALL_POINT, [{ id: "zz.structure", label: "Storm structure", kinds: ["zz.structure"], read: (el) => (el.id === "st-1" ? { elementId: el.id, label: "ST-1", invertMm: -1200, rimMm: 0, backwater: false } : null) }]),
    ]);
    expect(runPackConformance(pack).problems).toEqual([]);
    withPackSet(PackSet.create([pack]), () => {
      const site = { ...base, id: "site-1", kind: "zz.site_line" } as unknown as BimElement;
      const tray = { ...base, id: "tray-1", kind: "zz.tray" } as unknown as BimElement;
      const st = { ...base, id: "st-1", kind: "zz.structure" } as unknown as BimElement;
      const m: ModelState = { ...model, elements: { ...model.elements, "site-1": site } };
      expect(datumSnapLines(m, "L1" as ElementId).map((l) => l.label)).toEqual(["S1"]);
      const partition = { ...base, id: "p-1", kind: "zz.partition" } as unknown as BimElement;
      expect(boundsRooms(partition, {})).toBe(true);
      expect(boundsRooms({ ...partition, values: { room_bounding: false } } as unknown as BimElement, {})).toBe(false);
      expect(boundsRooms({ ...base, id: "x", kind: "zz.other" } as unknown as BimElement, {})).toBe(false);
      expect(ifcRelationRowsFor("zz.skylight").map((r) => r.id)).toEqual(["zz.voids"]);
      expect(connectorFacesOf(tray, {}).map((f) => f.id)).toEqual(["top"]);
      expect(connectionFieldValue({}, "zzRatedLoad")).toBe(0);
      expect(connectionFieldValue({ zzRatedLoad: 120 }, "zzRatedLoad")).toBe(120);
      expect(outfallOf(st, {})?.invertMm).toBe(-1200);
    });
    expect(pointOnFace(face, 500, 0)).toEqual([0, 0, 300]);
    expect(pointOnFace(face, 1200, 0)).toBeNull();
    expect(faceOfSide(1)).toBe("side_left");
  });

  it("malformed rows are refused in words", () => {
    const bad = outside("yy", [
      contribute(DATUM_POINT, [{ kind: "yy.d", label: " ", labelOf: () => "", snapLines: () => [] }]),
      contribute(LINE_JOIN_POINT, [{ kind: "yy.w", label: "W", styles: [], line: () => null, priority: () => 0 }]),
      contribute(HOST_VOID_POINT, [{ kind: "yy.v", label: "V", hostKinds: [], voidOf: () => null }]),
      contribute(CONNECTION_FIELD_POINT, [
        { id: "yy.a", label: "A", key: "yyLoad", valueType: "number", defaultValue: "x" },
        { id: "yy.b", label: "B", key: "yyLoad", valueType: "text", defaultValue: "" },
      ]),
      contribute(GRAVITY_OUTFALL_POINT, [{ id: "yy.o", label: "O", kinds: [], read: () => null }]),
    ]);
    const problems = runPackConformance(bad).problems.join("\n");
    expect(problems).toMatch(/datum yy.d has no label/);
    expect(problems).toMatch(/line join yy.w names no join style/);
    expect(problems).toMatch(/host void yy.v names no host kind/);
    expect(problems).toMatch(/connection field yy.a: default doesn't match its number type/);
    expect(problems).toMatch(/connection field yy.b: key yyLoad is already yy.a's/);
    expect(problems).toMatch(/gravity outfall yy.o names no kind/);
  });

  it("kind rows may carry a plan graphics face, and a non-function one is refused", () => {
    const pack = outside("xx", [contribute(ELEMENT_KIND_POINT, [{ kind: "xx.thing", label: "Thing", planGraphics: "draw" as never }])]);
    expect(runPackConformance(pack).problems.join("\n")).toMatch(/element kind xx.thing: planGraphics must be a function/);
  });

  it("nested spaces: sub-rooms sit inside a parent of the same kind, never in a loop, and schedules show them three ways", () => {
    const office = space("s-100");
    const a = space("s-100a", { parentId: "s-100" as ElementId });
    const b = space("s-100b", { parentId: "s-100" as ElementId });
    const other = space("s-200");
    const elements: Record<string, BimElement> = { [office.id]: office, [a.id]: a, [b.id]: b, [other.id]: other };
    expect(parentOf(elements, a)?.id).toBe("s-100");
    expect(childrenOf(elements, "s-100" as ElementId).map((s) => s.id)).toEqual(["s-100a", "s-100b"]);
    expect(nestingRefusal(elements, "s-100" as ElementId, "s-100a" as ElementId)).toBe("s-100a already sits inside s-100");
    expect(nestingRefusal(elements, "s-200" as ElementId, "s-200" as ElementId)).toBe("A space can't sit inside itself");
    expect(nestingRefusal(elements, "s-200" as ElementId, "s-100" as ElementId)).toBeNull();
    const records: NestedRecord[] = [office, a, b, other];
    const show = (d: "nested" | "children_only" | "parents_only") => nestedRows(elements, records, d).map((r) => `${"  ".repeat(r.depth)}${r.record.id}`);
    expect(show("nested")).toEqual(["s-100", "  s-100a", "  s-100b", "s-200"]);
    expect(show("children_only")).toEqual(["s-100a", "s-100b", "s-200"]);
    expect(show("parents_only")).toEqual(["s-100", "s-200"]);
  });

  it("a bounded space reads its stored outline in a bare reader (area from geometry)", () => {
    const outline = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 4000 }, { x: 0, y: 4000 }];
    const s = space("s-1", { bounds: { kind: "bounded", levelId: "L1" as ElementId, seed: { x: 3000, y: 2000 }, outline, boundary: [] } });
    expect(spaceAreaM2({}, s)).toBeCloseTo(24, 6);
  });

  it("the new kind and features are declared; only readers this build has are advertised", () => {
    expect(ELEMENT_KINDS).toContain("space_separator");
    for (const f of [SPACES_BOUNDED_FEATURE, SPACES_SEPARATORS_FEATURE, SPACES_NESTED_FEATURE]) {
      expect(CLIENT_FEATURES).toContain(f);
      expect(SERVER_FEATURES).toContain(f);
    }
    for (const f of [SPACES_BOUNDED_FEATURE, SPACES_SEPARATORS_FEATURE, SPACES_NESTED_FEATURE, PROTOCOL_FEATURES.elementsCreate, PROTOCOL_FEATURES.pipesOpenSpecs, PROTOCOL_FEATURES.routingTapFaces]) {
      expect(CLIENT_FEATURES).toContain(f);
    }
  });

  it("the Architecture add-on is first-party, installed with the others, and passes conformance", () => {
    expect(ARCHITECTURE_PACK.manifest.id).toBe("architecture");
    expect(ARCHITECTURE_PACK.manifest.firstParty).toBe(true);
    expect(FIRST_PARTY_ADDONS.map((p) => p.manifest.id)).toContain("architecture");
    expect(runPackConformance(ARCHITECTURE_PACK).problems).toEqual([]);
  });

  it("firm lookup tables: project over firm by slot, stage-bound, null when none so the check can say what to add", () => {
    const t = (id: string, stages?: string[]) => ({ id, slot: "zz.flow", name: id, columns: [{ key: "u", label: "Units" }], rows: [[1]], citation: { source: "Firm" }, ...(stages ? { stages } : {}) });
    expect(lookupTable("zz.flow", "cd", { firm: [t("firm")], project: [t("proj")] })?.id).toBe("proj");
    expect(lookupTable("zz.flow", "cd", { firm: [t("firm")], project: [t("proj", ["sd"])] })?.id).toBe("firm");
    expect(lookupTable("zz.flow", "cd", {})).toBeNull();
  });

  it("diagram selection reads are built: each answers in its own words, never 'isn't built yet'", () => {
    const answers = [modelIdsOf(model, "dg-1" as ElementId, "n-1"), diagramEntriesOf(model, "dg-1" as ElementId, "x-1" as ElementId)];
    for (const answer of answers) {
      const words = isPackRefusal(answer) ? answer.refused : "answered";
      expect(words).toBe("There is no view dg-1 in the model");
      expect(words).not.toMatch(/isn't built yet|aren't built yet/);
    }
  });
});
