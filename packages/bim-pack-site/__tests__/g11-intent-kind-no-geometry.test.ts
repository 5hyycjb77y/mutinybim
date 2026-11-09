/**
 * @jest-environment node
 *
 * Round 11 G11 (D3): pre-design records are intent kinds registered through
 * the element-kind row (`nature: "intent"`, values, no shape, no connector
 * ends, no plan position), owned by the Site and Development add-ons, never
 * the kernel. The lifecycle records register through the same row as
 * `record` kinds. Fails on round 10's code: none of these rows exist.
 */
import { ELEMENT_KIND_POINT, KERNEL_ELEMENT_KINDS, anchorOf, elementKindRowProblems, elementKindTable, isKernelElementKind, type BimElement } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { LIFECYCLE_KIND_ROWS } from "../../bim-kernel/src/lifecycle/records";
import { kernelKindRow } from "../../bim-kernel/src/registry/element-kind-point";
import { DEVELOPMENT_KIND_ROWS, DEVELOPMENT_PACK } from "../../bim-pack-development/src";
import { SITE_KIND, SITE_KIND_ROWS, SITE_PACK, SITE_VALUE } from "../src";

const KERNEL = new Set<string>(KERNEL_ELEMENT_KINDS);

describe("g11 intent kinds have no geometry", () => {
  it("every row is an intent with values and nothing drawn", () => {
    for (const row of [...SITE_KIND_ROWS, ...DEVELOPMENT_KIND_ROWS]) {
      expect(row.nature).toBe("intent");
      expect(row.shape).toBeUndefined();
      expect(row.connectorEnds).toBeUndefined();
      expect(row.anchor).toBeUndefined();
      expect((row.values ?? []).length).toBeGreaterThan(0);
      expect(isKernelElementKind(row.kind)).toBe(false);
    }
    expect(elementKindRowProblems([...SITE_KIND_ROWS, ...DEVELOPMENT_KIND_ROWS], KERNEL)).toEqual([]);
  });

  it("the lifecycle records are record kinds through the same row", () => {
    expect(LIFECYCLE_KIND_ROWS.map((r) => [r.kind, r.nature])).toEqual([
      ["gate", "record"],
      ["stage_plan", "record"],
    ]);
    // They are the kernel's own record rows (one registry with K11's): an add-on may not register them,
    // and each row is well formed under any add-on-shaped id.
    for (const r of LIFECYCLE_KIND_ROWS) expect(kernelKindRow(r.kind)).toBe(r);
    expect(elementKindRowProblems(LIFECYCLE_KIND_ROWS, KERNEL)).toHaveLength(LIFECYCLE_KIND_ROWS.length);
    expect(elementKindRowProblems(LIFECYCLE_KIND_ROWS.map((r) => ({ ...r, kind: `g11.${r.kind}` })), KERNEL)).toEqual([]);
  });

  it("both add-ons load together and their records sit nowhere in plan", () => {
    const set = PackSet.create([SITE_PACK, DEVELOPMENT_PACK]);
    const table = elementKindTable(set);
    expect(table.row(SITE_KIND.parcel)?.nature).toBe("intent");
    expect(table.valueOf(SITE_KIND.parcel, SITE_VALUE.area)?.unit).toBe("m2");
    expect(set.items(ELEMENT_KIND_POINT).filter((r) => r.nature === "intent").map((r) => r.kind).sort()).toEqual(["development.deal_assumption", "development.program_area", "site.constraint", "site.parcel"]);
    const p = { id: "P-1", kind: SITE_KIND.parcel, version: 1, authoredRev: {}, values: { [SITE_VALUE.area]: 500 } } as unknown as BimElement;
    expect(withPackSet(set, () => anchorOf(p))).toBeNull();
  });
});
