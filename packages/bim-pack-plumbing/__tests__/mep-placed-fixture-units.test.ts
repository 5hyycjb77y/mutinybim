/**
 * @jest-environment node
 *
 * Plumbing follow-ups (Nov 7): a water closet placed from the starter library
 * carries its fixture units at once, for the fixture schedule and for pipe
 * sizing, with no Connection types step: DFU 4 on its waste connector and
 * 5 WSFU on its cold water connector (the pack's WC-FT row). SC15 added the
 * adoption on placement; this pins the sizing side of it (the load the
 * drainage and Hunter water sizing read per connector).
 */
import { partConnectionTypeLoad, type PartInstance } from "@permitzip/bim-kernel";
import { resolvePlumbingField } from "../src/fields/plumbing";
import { toiletRoom } from "./p15-fixtures";

describe("a placed water closet carries its fixture units straight away", () => {
  it("schedule fields and sizing loads read DFU 4 / WSFU 5 with no extra step", () => {
    const m = toiletRoom();
    const wc = m.head.elements["wc-1"] as PartInstance;
    expect(wc.kind).toBe("part");
    expect(resolvePlumbingField(m.head.elements, "wc-1", "load.dfu")?.value).toBe(4);
    expect(resolvePlumbingField(m.head.elements, "wc-1", "load.wsfu_total")?.value).toBe(5);
    expect(partConnectionTypeLoad(m.head.elements, wc, "sanitary")).toBe(4);
    expect(partConnectionTypeLoad(m.head.elements, wc, "domestic_cold_water")).toBe(5);
  });
});
