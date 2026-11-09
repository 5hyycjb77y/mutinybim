/**
 * @jest-environment node
 *
 * Round 12 lane E: "needs a source" through the network adapter's generic
 * face. An unconnected receptacle asks the kernel `sourcesFor`; Electrical
 * answers with the panels that can take it (a free space at a voltage that
 * serves it), nearest first, and every other panel with its reason in words
 * ("L3 is full: 0 spare poles", the 480 V panel's voltage). A device already
 * on a circuit, a panel, or a part that isn't electrical gets no answer.
 *
 * On round 11's code there is no `sourcesFor` face on the adapter: the kernel
 * call returns null for every element and the grip can't exist.
 */
import { asElementId, sourcesFor } from "@permitzip/bim-kernel";
import { ELECTRICAL_SOURCE_PROMPT, electricalSourcesFor } from "@permitzip/bim-pack-electrical";
import { Building } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const end = (id: string) => ({ elementId: asElementId(id) });

/** L1 near the receptacle, L2 farther (both 120/208 V), H1 at 480 V, L3 full; r1 unconnected, r2 already on L1. */
function office(): Building {
  const b = new Building();
  b.place("l1", "panel208", { panel_name: "L1" }, "L1", { x: 3000, y: 0 });
  b.place("l2", "panel208", { panel_name: "L2" }, "L2", { x: 20000, y: 0 });
  b.place("h1", "panel480", { panel_name: "H1" }, "H1", { x: 1000, y: 0 });
  b.place("l3", "panel208", { panel_name: "L3" }, "L3", { x: 500, y: 0 });
  for (let i = 0; i < 14; i++) {
    b.place(`m${i}`, "mech3", { voltage: 208, load_va: 1000 }, `M-${i}`, { x: -5000, y: i * 1000 });
    // Seven 3-pole breakers down each side fill all 42 spaces.
    const first = i < 7 ? 1 + 6 * i : 2 + 6 * (i - 7);
    b.ok({ type: "create_service_link", linkId: `c-m${i}`, sourceId: "l3", positions: [first, first + 2, first + 4], members: [{ elementId: `m${i}` }] });
  }
  b.place("r1", "receptacle", { voltage: 120, load_va: 180 }, "r1", { x: 0, y: 0 });
  b.place("r2", "receptacle", { voltage: 120, load_va: 180 }, "r2", { x: 0, y: 2000 });
  b.ok({ type: "create_service_link", linkId: "c-r2", sourceId: "l1", positions: [1], members: [{ elementId: "r2" }] });
  return b;
}

describe("e12: a device with no source gets candidates and reasons", () => {
  it("lists the panels that can take it, nearest first, and the rest with their reason", () => {
    const b = office();
    const answer = sourcesFor(b.head, end("r1"));
    expect(answer?.sourceWord).toBe("panel");
    expect(answer?.prompt).toBe(ELECTRICAL_SOURCE_PROMPT);
    expect(answer?.candidates.map((c) => c.label)).toEqual(["L1", "L2"]);
    expect(answer?.candidates[0]).toMatchObject({ sourceId: "l1", distanceMm: 3000, note: expect.stringMatching(/^L1: \d+ spare, /) });
    const reasons = Object.fromEntries((answer?.refused ?? []).map((r) => [r.label, r.reason]));
    expect(reasons.L3).toBe("L3 is full: 0 spare poles");
    expect(reasons.H1).toMatch(/H1 is .*480/);
    expect(Object.keys(reasons).sort()).toEqual(["H1", "L3"]);
  });

  it("offers the free spaces that leave the panel most even, not simply the lowest (CI run 42258218369, WS-C)", () => {
    const b = office();
    // L1 carries r2 on space 1 (phase A): space 2 is free but also phase A, so the drop goes to phase B or C.
    const l1 = sourcesFor(b.head, end("r1"))?.candidates.find((c) => c.sourceId === "l1");
    expect(l1?.positions).toBeDefined();
    expect(l1?.positions).not.toEqual([2]);
    expect([3, 4, 5, 6]).toContain(l1?.positions?.[0]);
  });

  it("answers the same through the kernel's generic face as Electrical's own", () => {
    const b = office();
    expect(sourcesFor(b.head, end("r1"))).toEqual(electricalSourcesFor(b.head, end("r1")));
  });

  it("says nothing for a device already on a circuit, a panel, or something not electrical", () => {
    const b = office();
    expect(sourcesFor(b.head, end("r2"))).toBeNull();
    expect(sourcesFor(b.head, end("l1"))).toBeNull();
    expect(sourcesFor(b.head, end("lvl-1"))).toBeNull();
    expect(sourcesFor(b.head, end("nothing-here"))).toBeNull();
  });
});
