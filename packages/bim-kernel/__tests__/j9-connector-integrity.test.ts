/**
 * @jest-environment node
 *
 * Round 9 lane J9: connector integrity. Ends that touch but aren't joined,
 * a joined pair of parts whose openings differ in shape or size, end types
 * that don't join, and a part joined to a part on another system, all as
 * advice that never refuses an edit; end types come from the add-ons
 * (`CONNECTOR_END_TYPE_POINT`), and another add-on adds its own with zero
 * kernel edits. Fails on round 8b's code: there is no end type on a
 * connector, no end-type point and no integrity check.
 */
import {
  CONNECTOR_END_TYPE_POINT,
  CONNECTOR_END_TYPES_FEATURE,
  DEFAULT_SETTINGS,
  asElementId,
  checkEdit,
  commandSchema,
  connectorEndTypeTable,
  connectorEndTypeRowProblems,
  integrityPortsOf,
  jointIntegrityIssues,
  modelIntegrityIssues,
  planCommit,
  serviceLabel,
  validateModel,
  withUpgradePolicy,
  type BimElement,
  type ConnectorEndTypeItem,
  type ModelState,
  type PartInstance,
} from "@permitzip/bim-kernel";
import { straightPiece, IN, type End } from "./fixtures/j9-pieces";
import { PackSet, activePackSet, contribute, definePack, PACK_CONTRACT_VERSION, withPackSet } from "../src/packs";

const actor = { id: "u-j9", name: "J9", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: unknown): ModelState {
  seq += 1;
  const d = withUpgradePolicy(
    (f) => f === CONNECTOR_END_TYPES_FEATURE,
    () => planCommit(head, [], { idempotencyKey: `j9-${seq}-xxxxxxxxxxxx`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-11-01T12:00:00.000Z"),
  );
  if (!d.ok) throw new Error(`refused: ${d.error.message}`);
  return d.model;
}

function emptyModel(): ModelState {
  const head: ModelState = { modelId: "j9", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return commit(head, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
}

/** Two pieces end to end: A's `b` and B's `a` sit together at x = 150, facing each other. */
function twoPieces(a: End, b: End, gapMm = 0): ModelState {
  let m = emptyModel();
  m = commit(m, { type: "place_part", partId: "A", typeId: "j9-a", partType: straightPiece("A type", a), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 1000, mark: "A" });
  m = commit(m, { type: "place_part", partId: "B", typeId: "j9-b", partType: straightPiece("B type", b), levelId: "lvl-1", position: { x: 300 + gapMm, y: 0 }, offsetMm: 1000, mark: "B" });
  return m;
}

/** The two pieces' facing ends linked to each other, as an import or a stored model holds a part-to-part joint. */
function joined(m: ModelState): ModelState {
  const elements: Record<string, BimElement> = { ...m.elements };
  const a = elements.A as PartInstance;
  const b = elements.B as PartInstance;
  elements.A = { ...a, links: { b: { elementId: asElementId("B"), port: "a" } } };
  elements.B = { ...b, links: { a: { elementId: asElementId("A"), port: "b" } } };
  return { ...m, elements };
}

const checksOf = (m: ModelState) => modelIntegrityIssues(m.elements).map((i) => i.check);

describe("j9-touching-not-joined", () => {
  it("two open ends that sit together and face each other are reported, worded the same from either side", () => {
    const m = twoPieces({}, {});
    const found = modelIntegrityIssues(m.elements);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ check: "touching_not_joined", elementIds: ["A", "B"], message: "A's out and B's in touch but aren't joined" });
    expect(found[0]?.nextStep).toMatch(/Connect them/);
  });

  it("a 10 mm gap is not touching, and a joined pair is not reported as touching", () => {
    expect(checksOf(twoPieces({}, {}, 10))).toEqual([]);
    expect(checksOf(joined(twoPieces({}, {})))).toEqual([]);
  });

  it("ends of different domains that happen to meet are not reported", () => {
    expect(checksOf(twoPieces({}, { domain: "pipe", systemKind: "domestic_cold_water" }))).toEqual([]);
  });
});

describe("j9-round-meets-rectangular", () => {
  it("12 in round joined to 12×10 rectangular names both sizes and asks for a transition", () => {
    const found = modelIntegrityIssues(joined(twoPieces({}, { shape: "rect" })).elements);
    expect(found.map((i) => i.check)).toEqual(["shape_mismatch"]);
    expect(found[0]?.message).toBe("A's out (12 in round) meets B's in (12×10 in rectangular)");
    expect(found[0]?.nextStep).toMatch(/transition/);
  });

  it("10 in round joined to 12 in round is a size step with no transition", () => {
    const found = modelIntegrityIssues(joined(twoPieces({ diameter: 10 * IN }, {})).elements);
    expect(found.map((i) => i.message)).toEqual(["A's out (10 in round) meets B's in (12 in round) with no transition"]);
  });

  it("the same size and shape joined is clean", () => {
    expect(checksOf(joined(twoPieces({}, {})))).toEqual([]);
  });
});

describe("j9-slip-meets-flanged", () => {
  it("a slip end meeting a flanged end joins only with the fitting the Mechanical add-on names", () => {
    const found = modelIntegrityIssues(joined(twoPieces({ endType: "mechanical.slip" }, { endType: "mechanical.flanged" })).elements);
    expect(found.map((i) => i.check)).toEqual(["end_type_mismatch"]);
    expect(found[0]?.message).toBe("A's out has a slip end where it meets B's in, a flanged end; they join only with a slip-to-flange adapter");
  });

  it("two slip ends join; an end type no add-on declares is kept and judged by nothing", () => {
    expect(checksOf(joined(twoPieces({ endType: "mechanical.slip" }, { endType: "mechanical.slip" })))).toEqual([]);
    expect(checksOf(joined(twoPieces({ endType: "mechanical.slip" }, { endType: "firm.mystery_end" })))).toEqual([]);
  });

  it("a pipe fitting's stored joint is its end type: a sweat fitting on a threaded connection needs an adapter", () => {
    const table = connectorEndTypeTable();
    expect(table.resolveStored("joint", "sweat", "pipe")?.id).toBe("plumbing_gas.sweat");
    expect(table.join("plumbing_gas.sweat", "plumbing_gas.threaded")).toEqual({ kind: "via", fitting: "sweat-to-thread adapter" });
    let m = emptyModel();
    m = commit(m, { type: "place_part", partId: "V", typeId: "j9-v", partType: straightPiece("Valve", { domain: "pipe", systemKind: "domestic_cold_water", diameter: 1 * IN, endType: "plumbing_gas.threaded" }), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 1000, mark: "V-1" });
    const valve = m.elements.V as PartInstance;
    const fitting = {
      id: asElementId("F"),
      version: 1,
      authoredRev: {},
      kind: "run_fitting",
      fittingType: "elbow",
      label: "Elbow",
      domain: "pipe",
      systemId: asElementId("S"),
      levelId: asElementId("lvl-1"),
      position: { x: 150, y: 0, z: 1000 },
      ports: [{ id: "p1", position: { x: 150, y: 0, z: 1000 }, direction: { x: -1, y: 0, z: 0 }, size: { shape: "pipe", nominalMm: 25.4, material: "copper" }, link: { elementId: asElementId("V"), port: "b" } }],
      params: { joint: "sweat" },
    } as unknown as BimElement;
    const elements: Record<string, BimElement> = { ...m.elements, F: fitting, V: { ...valve, links: { b: { elementId: asElementId("F"), port: "p1" } } } };
    const [fp] = integrityPortsOf(elements, fitting);
    const vp = integrityPortsOf(elements, elements.V).find((p) => p.ref.port === "b");
    expect(fp?.endType).toBe("plumbing_gas.sweat");
    if (!fp || !vp) throw new Error("ports missing");
    const found = jointIntegrityIssues(fp, vp);
    expect(found.map((i) => i.check)).toEqual(["end_type_mismatch"]);
    expect(found[0]?.message).toMatch(/sweat \(soldered\) end .*threaded \(NPT\) end; they join only with a sweat-to-thread adapter$/);
  });
});

describe("j9-wrong-service", () => {
  it("a supply part joined to a return part says what each carries", () => {
    const found = modelIntegrityIssues(joined(twoPieces({}, { systemKind: "return_air" })).elements);
    expect(found.map((i) => i.check)).toEqual(["service_mismatch"]);
    expect(found[0]?.message).toBe(`A's out carries ${serviceLabel("supply_air").toLowerCase()} but is joined to B's in, which carries ${serviceLabel("return_air").toLowerCase()}`);
  });
});

describe("j9-never-blocks", () => {
  it("placing a piece so it touches another commits; the finding is advice, not a validation issue", () => {
    const m = twoPieces({}, {});
    expect(m.elements.B).toBeDefined();
    expect(checksOf(m)).toEqual(["touching_not_joined"]);
    expect(validateModel(m)).toEqual([]);
  });

  it("an edit that leaves a bad joint (slip on flanged, supply on return, round on rectangular) is not refused", () => {
    const prior = twoPieces({ endType: "mechanical.slip" }, { endType: "mechanical.flanged", systemKind: "return_air", shape: "rect" });
    const after = joined(prior);
    expect(checksOf(after).sort()).toEqual(["end_type_mismatch", "service_mismatch", "shape_mismatch"]);
    const check = checkEdit(prior, prior, after, [asElementId("A"), asElementId("B")]);
    expect(check.refusal).toBeNull();
  });
});

describe("j9-addon-end-types", () => {
  const GROOVED: ConnectorEndTypeItem = { id: "j9fp.grooved", label: "Grooved", domains: ["pipe"], joinsVia: [{ endType: "plumbing_gas.threaded", fitting: "grooved-to-thread adapter" }] };
  const FP = definePack({ id: "j9fp", name: "Fire protection (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(CONNECTOR_END_TYPE_POINT, [GROOVED])]);

  it("a test add-on adds an end type and a pair with zero kernel edits, joining another add-on's end type", () => {
    const set = PackSet.create([...activePackSet().packs, FP]);
    const table = connectorEndTypeTable(set);
    expect(table.row("j9fp.grooved")?.label).toBe("Grooved");
    expect(table.join("plumbing_gas.threaded", "j9fp.grooved")).toEqual({ kind: "via", fitting: "grooved-to-thread adapter" });
    expect(table.join("j9fp.grooved", "j9fp.grooved")).toEqual({ kind: "direct" });
    expect(table.join("j9fp.grooved", "plumbing_gas.sweat")).toEqual({ kind: "mismatch" });
    expect(connectorEndTypeTable().row("j9fp.grooved")).toBeUndefined();
    withPackSet(set, () => {
      const m = joined(twoPieces({ domain: "pipe", systemKind: "domestic_cold_water", endType: "j9fp.grooved" }, { domain: "pipe", systemKind: "domestic_cold_water", endType: "plumbing_gas.sweat" }));
      expect(modelIntegrityIssues(m.elements).map((i) => i.message)).toEqual(["A's out has a grooved end where it meets B's in, a sweat (soldered) end; those ends don't join"]);
    });
  });

  it("end-type rows are checked when an add-on contributes them", () => {
    expect(connectorEndTypeRowProblems([{ id: "x.a", label: " ", domains: [] }, { id: "x.b", label: "B", joinsVia: [{ endType: "x.a", fitting: "" }] }])).toEqual([
      "end type x.a has no label",
      "end type x.a: list at least one domain, or leave domains out for any",
      "end type x.b: say what fitting joins it to x.a",
    ]);
    expect(connectorEndTypeRowProblems(connectorEndTypeTable().ids.map((id) => connectorEndTypeTable().row(id) as ConnectorEndTypeItem))).toEqual([]);
  });
});

describe("j9 mixed-version peers (parts:connector_end_types)", () => {
  it("an end type on a connector is refused in the older-server words when a peer doesn't store it, saved once peers do", () => {
    const head = emptyModel();
    const place = { type: "place_part", partId: "A", typeId: "j9-a", partType: straightPiece("A type", { endType: "mechanical.slip" }), levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 1000, mark: "A" };
    const older = withUpgradePolicy(() => false, () => planCommit(head, [], { idempotencyKey: "j9-older-xxxxxxxxxxxx", baseRevision: head.revision, actor, command: commandSchema.parse(place) }));
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.error.message).toBe("J9 straight A type's In end type can't be saved yet: the model server this model is open on is an older version that doesn't store connector end types. Try again once the server is updated");
    const plain = withUpgradePolicy(() => false, () => planCommit(head, [], { idempotencyKey: "j9-plain-xxxxxxxxxxxx", baseRevision: head.revision, actor, command: commandSchema.parse({ ...place, partType: straightPiece("A type") }) }));
    expect(plain.ok).toBe(true);
    const typed = commit(head, place);
    const t = typed.elements["j9-a"];
    expect(t?.kind === "part_type" ? t.definition.connectors.map((c) => c.endType) : null).toEqual(["mechanical.slip", "mechanical.slip"]);
  });
});
