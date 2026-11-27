/**
 * @jest-environment node
 *
 * An opening element leaves exportIfc with a body, so a viewer cuts the wall
 * where a door, a window or a cased opening is (#167). Each
 * `IfcOpeningElement` was written with a placement and no body: the
 * `IfcRelVoidsElement` named a hole with no shape, and the wall stayed whole.
 * It is now the void the kernel states for the hosted record: its width and
 * height, through the wall's thickness, at its sill. A cased opening, which
 * no class takes and so is written as a proxy, also gets the Name the schema
 * asks every proxy to have.
 */
import type { BimElement, ModelState } from "@permitzip/bim-kernel";
import { danglingReferences, exportIfc, importIfc, readStep, type ReadEntity, type StepFile } from "../src";
import { twoLevels } from "../../bim-kernel/__tests__/a13a-fixtures";
import { num, ofType, ref, refs, text } from "./a13a-ifc-support";
import { hostModel } from "./i9-fixtures";

const PROJECT = { id: "8a3e6f10-2c47-4b9d-b5e8-1f7a0d4c9e62", name: "Synthetic openings" };

/** A wall along x with a door (D1) and a cased opening, and a wall along y with a window (W1). All 200 thick. */
function building(): ModelState {
  const m = twoLevels("opening-bodies");
  m.ok({ type: "create_element", elementId: "w1", levelId: "L1", kind: "wall", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 0, y: 0 }, end: { x: 8000, y: 0 } } });
  m.ok({ type: "create_element", elementId: "w2", levelId: "L1", kind: "wall", size: { thicknessMm: 200, heightMm: 3000 }, placement: { kind: "line", start: { x: 8000, y: 0 }, end: { x: 8000, y: 6000 } } });
  m.ok({ type: "create_hosted", elementId: "d1", kind: "opening", openingType: "door", mark: "D1", hostId: "w1", s: 1500, side: 1, size: { widthMm: 900, heightMm: 2100 } });
  m.ok({ type: "create_hosted", elementId: "o1", kind: "opening", openingType: "cased_opening", hostId: "w1", s: 5000, side: 1, size: { widthMm: 1000, heightMm: 2100 } });
  m.ok({ type: "create_hosted", elementId: "win1", kind: "opening", openingType: "window", mark: "W1", hostId: "w2", s: 3000, side: 1, size: { widthMm: 1200, heightMm: 1200 } });
  return m.head;
}

function exported(model: ModelState) {
  const out = exportIfc({ model, project: PROJECT, timeStamp: "2026-11-25T00:00:00" });
  const file = readStep(out.text);
  expect(danglingReferences(file)).toEqual([]);
  const entityOf = (id: string): ReadEntity => {
    const guid = out.report.globalIds[id];
    const e = [...file.entities.values()].find((x) => x.args[0]?.kind === "string" && x.args[0].value === guid);
    if (!e) throw new Error(`no entity for ${id}`);
    return e;
  };
  return { text: out.text, file, entityOf, warnings: out.report.warnings };
}

function get(file: StepFile, id: number): ReadEntity {
  const e = file.entities.get(id);
  if (!e) throw new Error(`no entity #${id}`);
  return e;
}

const coords = (file: StepFile, pointId: number): number[] => {
  const c = get(file, pointId).args[0];
  return c?.kind === "list" ? c.items.map((t) => (t.kind === "number" ? t.value : NaN)) : [];
};

/** The opening element that voids `host` and belongs to `filler` (the door, window or cased opening record it was written for). */
function openingFor(file: StepFile, host: ReadEntity, filler: ReadEntity): ReadEntity {
  const voids = ofType(file, "IFCRELVOIDSELEMENT").filter((r) => ref(r, 4) === host.id).map((r) => get(file, ref(r, 5)));
  const found = voids.find((o) => ref(get(file, ref(o, 5)), 0) === ref(filler, 5));
  if (!found) throw new Error("no opening element for it");
  return found;
}

/** An opening element's hole: its box in its own frame, as [width along the wall, depth through it, height], and where the box starts. */
function holeOf(file: StepFile, opening: ReadEntity) {
  const rep = get(file, refs(get(file, ref(opening, 6)), 2)[0] ?? -1);
  const items = refs(rep, 3).map((id) => get(file, id));
  const solid = items[0];
  if (!solid) throw new Error("no solid");
  const profile = get(file, ref(solid, 0));
  const at = get(file, ref(solid, 1));
  return {
    representation: [text(rep, 1), text(rep, 2)],
    items: items.map((i) => i.type),
    profile: profile.type,
    profileCentre: coords(file, ref(get(file, ref(profile, 2)), 0)),
    size: [num(profile, 3), num(profile, 4), num(solid, 3)],
    from: coords(file, ref(at, 0)),
    // Pushed straight up in its own frame, which is not turned.
    up: coords(file, ref(solid, 2)),
    turned: at.args[1]?.kind !== "null" || at.args[2]?.kind !== "null",
  };
}

describe("openings in the exported file", () => {
  it.each([
    ["a door", "d1", "w1", [900, 200, 2100]],
    ["a window", "win1", "w2", [1200, 200, 1200]],
    ["a cased opening", "o1", "w1", [1000, 200, 2100]],
  ] as const)("the opening element of %s is the hole through the wall: its width, the wall's thickness, its height", (_what, id, wallId, size) => {
    const { file, entityOf } = exported(building());
    const opening = openingFor(file, entityOf(wallId), entityOf(id));
    expect(opening.type).toBe("IFCOPENINGELEMENT");
    expect(text(opening, 8)).toBe("OPENING");
    expect(holeOf(file, opening)).toEqual({ representation: ["Body", "SweptSolid"], items: ["IFCEXTRUDEDAREASOLID"], profile: "IFCRECTANGLEPROFILEDEF", profileCentre: [0, 0], size: [...size], from: [0, 0, 0], up: [0, 0, 1], turned: false });
  });

  it("the hole sits where the door, window or cased opening does: at its point on the wall, turned with the wall, at its sill", () => {
    const { file, entityOf } = exported(building());
    for (const [id, wallId, origin, turned] of [["d1", "w1", [1500, 0, 0], false], ["o1", "w1", [5000, 0, 900], false], ["win1", "w2", [8000, 3000, 900], true]] as const) {
      const filler = entityOf(id);
      const placement = get(file, ref(openingFor(file, entityOf(wallId), filler), 5));
      // Placed on the record's own placement with no shift, so the two can never drift apart.
      expect(ref(placement, 0)).toBe(ref(filler, 5));
      const own = get(file, ref(placement, 1));
      expect([coords(file, ref(own, 0)), own.args[1]?.kind, own.args[2]?.kind]).toEqual([[0, 0, 0], "null", "null"]);
      const at = get(file, ref(get(file, ref(filler, 5)), 1));
      expect(coords(file, ref(at, 0))).toEqual([...origin]);
      // A wall along y turns the frame: local x is world y.
      expect(at.args[2]?.kind === "ref" ? coords(file, ref(at, 2)).map((n) => Math.round(n * 1e6) / 1e6) : null).toEqual(turned ? [0, 1, 0] : null);
    }
  });

  it("each opening element still voids its wall once, and only a door or window fills one", () => {
    const { file, entityOf } = exported(building());
    const openings = ofType(file, "IFCOPENINGELEMENT");
    expect(openings).toHaveLength(3);
    for (const o of openings) expect(ofType(file, "IFCRELVOIDSELEMENT").filter((r) => ref(r, 5) === o.id)).toHaveLength(1);
    const fills = ofType(file, "IFCRELFILLSELEMENT").map((r) => [get(file, ref(r, 4)).type, get(file, ref(r, 5)).type]);
    expect(fills.sort()).toEqual([["IFCOPENINGELEMENT", "IFCDOOR"], ["IFCOPENINGELEMENT", "IFCWINDOW"]]);
    expect(ref(openingFor(file, entityOf("w1"), entityOf("d1")), 5)).not.toBe(ref(openingFor(file, entityOf("w1"), entityOf("o1")), 5));
    // A hole is never contained in a storey: it is in the building through the wall it voids.
    const contained = ofType(file, "IFCRELCONTAINEDINSPATIALSTRUCTURE").flatMap((c) => refs(c, 4));
    expect(openings.filter((o) => contained.includes(o.id))).toEqual([]);
  });

  it("a cased opening written as a proxy has a Name: its mark when it has one, else what it is", () => {
    const model = building();
    const { entityOf, warnings } = exported(model);
    const proxy = entityOf("o1");
    expect(proxy.type).toBe("IFCBUILDINGELEMENTPROXY");
    expect(text(proxy, 2)).toBe("Cased opening");
    // The tag stays the mark alone, so a made-up name is never read back as a mark.
    expect(proxy.args[7]?.kind).toBe("null");
    expect(warnings.filter((w) => w.includes("hole"))).toEqual([]);
    const marked = { ...model, elements: { ...model.elements, o1: { ...model.elements["o1"], mark: "CO-1" } as BimElement } };
    const again = exported(marked).entityOf("o1");
    expect([text(again, 2), text(again, 7)]).toEqual(["CO-1", "CO-1"]);
  });

  it("an opening in a wall with no thickness is written without a hole, and the report names it", () => {
    const model = building();
    const thin = { ...model, elements: { ...model.elements, w2: { ...model.elements["w2"], thickness: 0 } as BimElement } };
    const { file, entityOf, warnings } = exported(thin);
    const opening = openingFor(file, entityOf("w2"), entityOf("win1"));
    expect(opening.args[6]?.kind).toBe("null");
    expect(warnings).toContain("win1: the model has no size for the hole it cuts, so its host is not cut there in the file. Check its width, its height and the thickness of what it is in, then export again");
    // The others are untouched.
    expect(openingFor(file, entityOf("w1"), entityOf("d1")).args[6]?.kind).toBe("ref");
  });

  it("the door and window come back as they were, and the cased opening comes back named", () => {
    const { text: ifc } = exported(building());
    const plan = importIfc(ifc, { model: hostModel([{ id: "L1", name: "Level 1", elevationMm: 0 }, { id: "L2", name: "Level 2", elevationMm: 4000 }]), referenceId: "ref", sourceKey: "v1", sourceId: "ver-1", label: "Round trip", disciplines: ["architecture"] });
    const openings = plan.records.flatMap((r) => (r.kind === "opening" ? [{ openingType: r.openingType, mark: r.mark, offset: r.offset, width: r.width, height: r.height }] : []));
    expect(openings.sort((a, b) => (a.mark < b.mark ? -1 : 1))).toEqual([
      { openingType: "door", mark: "D1", offset: 1500, width: 900, height: 2100 },
      { openingType: "window", mark: "W1", offset: 3000, width: 1200, height: 1200 },
    ]);
    expect(plan.records.filter((r) => r.kind === "wall")).toHaveLength(2);
    // No class takes a cased opening yet, so it is read as a generic model, as before; it now carries its name.
    expect(plan.records.flatMap((r) => (r.kind === "part" ? [r.mark] : []))).toEqual(["Cased opening"]);
  });
});
