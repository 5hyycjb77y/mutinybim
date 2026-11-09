/**
 * @jest-environment node
 *
 * Round 13 lane P13 (Bedrock proof): an outside civil add-on's storm
 * structure ends a storm drain's walk through `kernel.gravity_outfall` with
 * zero kernel edits. The add-on reads its own part type's values (invert,
 * rim); the kernel walks the drawn pipe to it. Without the add-on the same
 * drain reaches no outfall and the refusal says what to draw.
 *
 * Fails on round 12's code: there was no outfall point and `walkToOutfall`
 * refused every walk ("isn't built yet").
 */
import { GRAVITY_OUTFALL_POINT, asElementId, walkToOutfall, type BimElement, type GravityOutfallRow, type PartTypeDefinition, type RunSegment } from "../src";
import { PackSet, contribute, definePack, withPackSet } from "../src/packs";
import { DrainageBuilding, FT } from "./drainage-fixtures";

const IN = 25.4;

const STRUCTURE: PartTypeDefinition = {
  familyName: "Storm structure",
  typeName: "Curb inlet",
  category: "pipe_accessory",
  typeParams: [{ name: "zzcivil_structure", label: "Storm structure", kind: "boolean" }],
  typeValues: { zzcivil_structure: true },
  instanceParams: [
    { name: "zzcivil_invert", label: "Invert", kind: "length" },
    { name: "zzcivil_rim", label: "Rim", kind: "length" },
  ],
  tagFields: [],
  geometry: [{ kind: "box", center: [0, 0, 300], size: [900, 900, 600] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [900, 900] }],
  connectors: [],
  source: { kind: "builtin", libraryVersion: "test" },
};

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

const STRUCTURE_ROW: GravityOutfallRow = {
  id: "zzcivil.storm_structure",
  label: "Storm structure",
  kinds: ["part"],
  read: (el, elements) => {
    if (el.kind !== "part") return null;
    const type = elements[el.typeId];
    if (type?.kind !== "part_type" || type.definition.typeValues.zzcivil_structure !== true) return null;
    return { elementId: el.id, label: el.mark, invertMm: num(el.values.zzcivil_invert), rimMm: num(el.values.zzcivil_rim), backwater: false };
  },
};

const CIVIL = definePack({ id: "zzcivil", name: "Test civil", version: "1.0.0", kernel: "^1.0.0" }, [contribute(GRAVITY_OUTFALL_POINT, [STRUCTURE_ROW])]);

function site(): { b: DrainageBuilding; first: string } {
  const b = new DrainageBuilding();
  b.ok({ type: "place_part", partId: "cb-1", typeId: "type-cb", partType: STRUCTURE, levelId: "lvl-1", position: { x: 40 * FT, y: 0 }, mark: "CB-1", values: { zzcivil_invert: -6 * FT, zzcivil_rim: 0 } });
  b.ok({ type: "route_run", idPrefix: "st", levelId: "lvl-1", domain: "pipe", size: { shape: "pipe", nominalMm: 6 * IN, material: "pvc" }, elevationMm: 300, system: { id: "storm-1", kind: "storm", name: "Storm" }, points: [{ x: 0, y: 0 }, { x: 30 * FT, y: 0 }] });
  const seg = Object.values(b.head.elements).find((e): e is RunSegment => e.kind === "run_segment" && e.systemId === "storm-1");
  const part = b.head.elements["cb-1"];
  if (!seg || part?.kind !== "part") throw new Error("nothing drawn");
  const next: Record<string, BimElement> = { ...b.head.elements };
  next[seg.id] = { ...seg, links: { ...seg.links, end: { elementId: asElementId("cb-1"), port: "inlet" } } };
  next["cb-1"] = { ...part, links: { inlet: { elementId: seg.id, port: "end" } } };
  b.head = { ...b.head, elements: next };
  return { b, first: seg.id };
}

describe("p13-outside-pack-storm-outfall", () => {
  it("an outside add-on's storm structure ends the walk, read through its own row", () => {
    const { b, first } = site();
    const walk = withPackSet(PackSet.create([CIVIL]), () => walkToOutfall(b.head, asElementId(first)));
    if ("refused" in walk) throw new Error(walk.refused);
    expect(walk.outfall).toEqual({ elementId: "cb-1", label: "CB-1", invertMm: -6 * FT, rimMm: 0, backwater: false });
    expect(walk.path).toEqual([first, "cb-1"]);
  });

  it("without the add-on the drain reaches no outfall, and the refusal says what to draw", () => {
    const { b, first } = site();
    const walk = walkToOutfall(b.head, asElementId(first));
    expect("refused" in walk ? walk.refused : null).toBe(`Nothing drawn connects ${first} to where it leaves the building: draw the line on to an outfall (a connection to the public main, a structure or a receptor)`);
  });
});
