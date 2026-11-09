/**
 * @jest-environment node
 *
 * s12-assembly-stubs: a bathroom group made a typical (unit 001 and three
 * copies) exposes one stub per service it needs from outside, each with the
 * group's rolled-up need for one instance, placed at the middle of the parts
 * its loads stand for (relative to the base point), and counting four times
 * upstream by the multiplier, never by expanding copies. A load with no
 * service has no stub; a load outside the group isn't counted.
 *
 * Fails on round 11's code: there are no assembly stubs (wave 0 refuses
 * "Assembly stubs aren't built yet").
 */
import { isPackRefusal } from "../src";
import { fixedSpaceLocator, type BimElement, type ElementId, type ModelState } from "@permitzip/bim-kernel";
import { assemblyStubs, assemblyStubEnd, stubTotalNeed, type AssemblyStub } from "@permitzip/bim-kernel/typicals";

const group = (typical: boolean): BimElement =>
  ({
    id: "g-bath",
    kind: "organization",
    entry: {
      type: "group",
      name: "Bathroom 001",
      color: "#336699",
      description: "",
      locked: false,
      defaultVisibility: "show",
      order: 1,
      ...(typical ? { typical: { label: "Unit", mark: "001", basePoint: { x: 1000, y: 0 }, copies: ["002", "003", "004"].map((mark, i) => ({ id: `g-bath:${mark}`, mark, offset: { x: (i + 1) * 6000, y: 0 }, rotationDeg: 0 })) } } : {}),
    },
  }) as unknown as BimElement;

const part = (id: string, x: number, groupId?: string): BimElement => ({ id, kind: "part", position: { x, y: 2000 }, rotationDeg: 0, ...(groupId ? { groupId } : {}) }) as unknown as BimElement;

const load = (id: string, service: string | undefined, values: Record<string, number>, attachedPartId?: string, groupId?: string): BimElement =>
  ({ id, kind: "load_point", version: 1, authoredRev: {}, connectionType: "", values, ...(service ? { service } : {}), ...(attachedPartId ? { attachedPartId } : {}), ...(groupId ? { groupId } : {}) }) as unknown as BimElement;

function model(typical: boolean): ModelState {
  const els = [
    group(typical),
    part("wc-1", 1000, "g-bath"),
    part("lav-1", 3000, "g-bath"),
    load("lp-wc-cw", "cold_water", { wsfu_cold: 2.5, wsfu_total: 2.5 }, "wc-1"),
    load("lp-lav-cw", "cold_water", { wsfu_cold: 1.5, wsfu_total: 2 }, "lav-1"),
    load("lp-lav-hw", "hot_water", { wsfu_hot: 1.5 }, "lav-1"),
    load("lp-wc-san", "sanitary", { dfu: 4 }, "wc-1"),
    load("lp-floor", "sanitary", { dfu: 2 }, undefined, "g-bath"),
    load("lp-unassigned", undefined, { dfu: 1 }, "wc-1"),
    part("hb-1", 50_000),
    load("lp-outside", "cold_water", { wsfu_cold: 9 }, "hb-1"),
  ];
  return { elements: Object.fromEntries(els.map((e) => [e.id, e])) } as unknown as ModelState;
}

const locator = fixedSpaceLocator({});

describe("s12-assembly-stubs", () => {
  it("one stub per service, the need rolled up for one instance, at the middle of its parts", () => {
    const stubs = assemblyStubs(model(true), "g-bath" as ElementId, locator);
    if (isPackRefusal(stubs)) throw new Error(stubs.refused);
    expect(stubs.map((s) => [s.id, s.serviceId, s.end, s.instances, s.need])).toEqual([
      ["g-bath#stub:cold_water", "cold_water", assemblyStubEnd("cold_water"), 4, { wsfu_cold: 4, wsfu_total: 4.5 }],
      ["g-bath#stub:hot_water", "hot_water", "stub:hot_water", 4, { wsfu_hot: 1.5 }],
      ["g-bath#stub:sanitary", "sanitary", "stub:sanitary", 4, { dfu: 6 }],
    ]);
    const cold = stubs[0] as AssemblyStub;
    expect(cold.position).toEqual({ x: 1000, y: 2000 });
    expect(stubs[2]?.position).toEqual({ x: 0, y: 2000 });
    expect(typeof cold.label).toBe("string");
    expect(cold.label.length).toBeGreaterThan(0);
  });

  it("upstream totals count the stub by the multiplier", () => {
    const stubs = assemblyStubs(model(true), "g-bath" as ElementId, locator);
    if (isPackRefusal(stubs)) throw new Error(stubs.refused);
    expect(stubTotalNeed(stubs[0] as AssemblyStub)).toEqual({ wsfu_cold: 16, wsfu_total: 18 });
    const plain = assemblyStubs(model(false), "g-bath" as ElementId, locator);
    if (isPackRefusal(plain)) throw new Error(plain.refused);
    expect(plain[0]?.instances).toBe(1);
    expect(plain[0]?.position).toEqual({ x: 2000, y: 2000 });
  });

  it("a group that isn't there is refused in words", () => {
    expect(assemblyStubs(model(true), "g-nope" as ElementId, locator)).toEqual({ refused: "g-nope isn't a group in this model" });
  });
});
