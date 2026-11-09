/**
 * @jest-environment node
 *
 * Round 9 lane J9: connector integrity on the Checklist. The four rules
 * report the kernel's findings as warnings (never an issue that blocks an
 * edit), from the full check and from an edit's scope, where an open end
 * finds the others through the lint grid. Fails on round 8b's code: the
 * rules don't exist.
 */
import { asElementId, type BimElement, type PartInstance } from "@permitzip/bim-kernel";
import { ALL_RULES, LintEngine } from "../src";
import { Model, config, rulesFired } from "./fixtures";
import { straightPiece, IN, type End } from "../../bim-kernel/__tests__/fixtures/j9-pieces";

const CONNECTOR_RULES = ["connector-touching-not-joined", "connector-shape-size-mismatch", "connector-end-type-mismatch", "connector-service-mismatch"];

function piecesModel(a: End, b: End, at = 300): Model {
  const m = new Model();
  m.put({ id: asElementId("ta"), version: 1, authoredRev: {}, kind: "part_type", definition: straightPiece("A type", a) } as BimElement, { id: asElementId("tb"), version: 1, authoredRev: {}, kind: "part_type", definition: straightPiece("B type", b) } as BimElement);
  m.ok({ type: "place_part", partId: "A", typeId: "ta", levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 1000, mark: "A" });
  m.ok({ type: "place_part", partId: "B", typeId: "tb", levelId: "lvl-1", position: { x: at, y: 0 }, offsetMm: 1000, mark: "B" });
  return m;
}

function joinPieces(m: Model): void {
  const a = m.head.elements.A as PartInstance;
  const b = m.head.elements.B as PartInstance;
  m.put({ ...a, links: { b: { elementId: asElementId("B"), port: "a" } } }, { ...b, links: { a: { elementId: asElementId("A"), port: "b" } } });
}

describe("j9 connector rules", () => {
  it("are warnings in the systems pack, so they show on the Checklist and never block", () => {
    const rules = ALL_RULES.filter((r) => CONNECTOR_RULES.includes(r.id));
    expect(rules.map((r) => [r.id, r.severity, r.pack, r.scope])).toEqual(CONNECTOR_RULES.map((id) => [id, "warning", "systems", "element"]));
  });

  it("touching but not joined fires in the full check, with the next step", () => {
    const fired = rulesFired(piecesModel({}, {}).head);
    expect(fired.get("connector-touching-not-joined")).toEqual(["A's out and B's in touch but aren't joined. Connect them (drag one end onto the other), or move one away"]);
    expect(rulesFired(piecesModel({}, {}, 320).head).get("connector-touching-not-joined")).toBeUndefined();
  });

  it("an edit's scope finds it through the grid: only the placed part is in scope", () => {
    const m = new Model();
    m.put({ id: asElementId("ta"), version: 1, authoredRev: {}, kind: "part_type", definition: straightPiece("A type") } as BimElement);
    m.ok({ type: "place_part", partId: "A", typeId: "ta", levelId: "lvl-1", position: { x: 0, y: 0 }, offsetMm: 1000, mark: "A" });
    const e = new LintEngine();
    e.build(m.head);
    const changed = m.ok({ type: "place_part", partId: "B", typeId: "ta", levelId: "lvl-1", position: { x: 300, y: 0 }, offsetMm: 1000, mark: "B" });
    e.advance(m.head, changed);
    const found = e.check({ config: config({ ruleset: "default" }), ids: ["B"] }).filter((f) => f.rule === "connector-touching-not-joined");
    expect(found.map((f) => [f.elementIds, f.severity])).toEqual([[["A", "B"], "warning"]]);
  });

  it("a joined pair reports end type, shape and service, each under its own rule", () => {
    const m = piecesModel({ endType: "mechanical.slip" }, { endType: "mechanical.flanged", shape: "rect", systemKind: "return_air", width: 12 * IN });
    joinPieces(m);
    const fired = rulesFired(m.head);
    expect(fired.get("connector-touching-not-joined")).toBeUndefined();
    expect(fired.get("connector-end-type-mismatch")?.[0]).toMatch(/^A's out has a slip end where it meets B's in, a flanged end; they join only with a slip-to-flange adapter/);
    expect(fired.get("connector-shape-size-mismatch")?.[0]).toMatch(/12 in round\) meets B's in \(12×10 in rectangular\)/);
    expect(fired.get("connector-service-mismatch")?.[0]).toMatch(/^A's out carries .* but is joined to B's in, which carries /);
  });

  it("a firm can turn one off", () => {
    const fired = rulesFired(piecesModel({}, {}).head, [], { disabled_rules: ["connector-touching-not-joined"] });
    expect(fired.get("connector-touching-not-joined")).toBeUndefined();
  });
});
