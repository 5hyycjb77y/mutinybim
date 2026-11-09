/**
 * @jest-environment node
 *
 * A13b bedrock proof: an add-on that isn't first-party adds a "demountable
 * partition" kind of its own and makes it bound rooms through one
 * `kernel.bounding_element` row, with a type parameter of its own name to
 * switch it off. Rooms form from it with zero kernel edits; without the
 * add-on its records bound nothing.
 *
 * Fails on round 12's code: there is no boundary index, face walk or
 * `place_space_in_walls`, so the partition's row is read by nobody.
 */
import { asElementId, withUpgradePolicy, type BimElement } from "../src";
import { contribute, definePack, PACK_CONTRACT_VERSION, PackSet, withPackSet } from "../src/packs";
import { executeSpaceDesignCommand } from "../src/spaces/space-commands";
import { BOUNDING_ELEMENT_POINT, boundingElementRowProblems } from "../src/spaces/boundaries/point";
import { roomAt } from "../src/spaces/boundaries/room-at";
import { SPACES_BOUNDED_FEATURE } from "../src/spaces/boundary-facts";
import { spaceAreaM2 } from "../src/spaces/space-geometry";
import { box, L1, lineRow, modelWith } from "./a13b-fixtures";

const PARTITION_ROW = lineRow("zzpart.partition", "Demountable partition", "zzpart.bounds");
const PARTITION_PACK = definePack({ id: "zzpart", name: "Demountable partitions (test)", version: "1.0.0", kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(BOUNDING_ELEMENT_POINT, [PARTITION_ROW])]);
const WITH_PARTITIONS = PackSet.create([PARTITION_PACK]);
const WALLS_ONLY = PackSet.create([]);

const partition = (extra: Record<string, unknown> = {}): BimElement =>
  ({ id: asElementId("pt-1"), kind: "zzpart.partition", version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "A", discipline: "architecture" }, start: { x: 3000, y: 0 }, end: { x: 3000, y: 4000 }, thickness: 100, ...extra }) as unknown as BimElement;

describe("a13b outside pack bounding partition", () => {
  it("its row is well formed", () => {
    expect(boundingElementRowProblems([PARTITION_ROW])).toEqual([]);
  });

  it("its partition splits a room into two through its row alone", () => {
    const m = modelWith([...box("w", 0, 0, 6000, 4000), partition()]);
    const r = withPackSet(WITH_PARTITIONS, () => withUpgradePolicy((f) => f === SPACES_BOUNDED_FEATURE, () => executeSpaceDesignCommand(m, { type: "place_space_in_walls", spaceId: "s-w", levelId: "L1", seed: { x: 1000, y: 2000 }, name: "West" })));
    if (!r.ok) throw new Error(r.error.message);
    const s = r.model.elements["s-w"];
    if (s?.kind !== "space" || s.bounds.kind !== "bounded") throw new Error("no bounded space");
    expect(spaceAreaM2(r.model.elements, s)).toBeCloseTo(2.85 * 3.8, 6);
    expect(s.bounds.boundary.map((b) => b.elementId)).toContain("pt-1");
  });

  it("its own type parameter switches it off", () => {
    const type = { id: asElementId("t-pt"), kind: "element_type", version: 1, authoredRev: {}, name: "Open partition", values: { "zzpart.bounds": false } } as BimElement;
    const m = modelWith([...box("w", 0, 0, 6000, 4000), type, partition({ typeId: "t-pt" })]);
    const r = withPackSet(WITH_PARTITIONS, () => roomAt(m.elements, L1, { x: 1000, y: 2000 }));
    expect(r.ok && r.boundary.some((b) => b.elementId === "pt-1")).toBe(false);
  });

  it("without the add-on its records bound nothing", () => {
    const m = modelWith([...box("w", 0, 0, 6000, 4000), partition()]);
    const r = withPackSet(WALLS_ONLY, () => roomAt(m.elements, L1, { x: 1000, y: 2000 }));
    expect(r.ok && r.boundary.map((b) => b.elementId).sort()).toEqual(["w-e", "w-n", "w-s", "w-w"]);
  });
});
