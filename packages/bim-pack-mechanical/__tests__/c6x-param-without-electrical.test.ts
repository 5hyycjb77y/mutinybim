/**
 * @jest-environment node
 *
 * c6x-param-without-electrical (@mutinybim-bare-kernel): `param.<name>` field
 * paths are the kernel's, so a host with Mechanical and no Electrical reads a
 * unit's outdoor air. Before round 6 lane X only Electrical's field resolver
 * answered `param.`, and without it every unit's outdoor air read unknown.
 */
import { to } from "@permitzip/bim-units";
import { asElementId, DEFAULT_SETTINGS, isResolvableFieldPath, resolveField, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { MECHANICAL_PACK, OUTDOOR_AIR_ENGINE } from "../src";

const L1 = asElementId("L1");
const RTU = asElementId("rtu-1");
const Z1 = asElementId("z1");

function model(): ModelState {
  const els: BimElement[] = [
    { id: L1, kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 },
    { id: asElementId("s1"), kind: "space", version: 1, authoredRev: {}, number: "101", name: "Dining", levelId: L1, bounds: { kind: "outline", outline: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }] }, origin: { kind: "drawn" } },
    { id: RTU, kind: "part", version: 1, authoredRev: {}, typeId: asElementId("no-type"), levelId: L1, position: { x: 0, y: 0 }, offsetMm: 0, rotationDeg: 0, mark: "RTU-1", values: { outdoor_cfm: 1200, note: " roof " } },
    { id: Z1, kind: "zone", version: 1, authoredRev: {}, name: "Zone 1", purpose: "thermal", spaceIds: [asElementId("s1")], servedBy: RTU },
  ];
  return { modelId: "c6x", revision: 0 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

describe("c6x-param-without-electrical", () => {
  beforeAll(() => installFirstPartyPacks([MECHANICAL_PACK]));

  it("reads a part parameter through param.<name> with no Electrical", () => {
    const m = model();
    expect(resolveField(m.elements, RTU, "param.outdoor_cfm")).toEqual({ path: "param.outdoor_cfm", value: 1200, text: "1200" });
    expect(resolveField(m.elements, RTU, "param.note")).toEqual({ path: "param.note", value: "roof", text: "roof" });
    expect(resolveField(m.elements, RTU, "param.missing")).toEqual({ path: "param.missing", value: null, text: "" });
    expect(resolveField(m.elements, Z1, "param.outdoor_cfm").value).toBeNull();
    expect(isResolvableFieldPath("param.outdoor_cfm")).toBe(true);
    expect(isResolvableFieldPath("param.")).toBe(false);
  });

  it("gives the zone its serving unit's outdoor air", () => {
    const oa = OUTDOOR_AIR_ENGINE.zone(model().elements, Z1)?.servedBy?.outdoorAir ?? null;
    expect(oa === null ? null : to(oa, "cfm")).toBeCloseTo(1200, 6);
  });
});
