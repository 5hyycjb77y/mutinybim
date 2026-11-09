/**
 * @jest-environment node
 *
 * M1 (round 15): Mechanical › Connect › To duct joins the selected diffusers
 * to the nearest duct of their system in one edit (a tap, a short rigid piece
 * and flex into each neck), through the kernel's `connect_into`; and the "+"
 * grip on a diffuser offers the nearest supply duct. Round 14 had neither:
 * flex only joined an open round end of the same size within reach, so each
 * diffuser needed a branch drawn to it first, and the mechanical adapter row
 * answered no grip (`sourcesFor` was absent, so hovering a diffuser offered nothing).
 */
import { asElementId, connectToSource, sourcesFor, validateModel } from "@permitzip/bim-kernel";
import { PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { DIFFUSER, FT, IN, K15Model, SA } from "../../bim-kernel/__tests__/k15-fixtures";
import { MECHANICAL_PACK } from "../src/pack";
import { airConnectBlocked, airConnectSources, previewAirConnect } from "../src/connect/terminals";
import { AIR_CONNECT_WORDS } from "../src/ui";

/** A 14x10 supply trunk at 10 ft along y = 0, and `n` 24x24 diffusers 5 ft north of it, 8 ft apart. */
function officeCeiling(n: number): K15Model {
  const m = new K15Model();
  m.ok({ type: "route_run", idPrefix: "trunk", levelId: "lvl-1", domain: "duct", size: { shape: "rect", width: 14 * IN, height: 10 * IN }, elevationMm: 10 * FT, system: SA, points: [{ x: -4 * FT, y: 0 }, { x: (8 * n + 4) * FT, y: 0 }] });
  for (let i = 0; i < n; i++) m.place(`sd-${i + 1}`, DIFFUSER, (4 + 8 * i) * FT, 5 * FT, 8 * FT, `SD-${i + 1}`);
  return m;
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `sd-${i + 1}`);

describe("Mechanical › Connect › To duct", () => {
  it("previews each diffuser (tap and flex into its neck) and changes nothing", () => {
    const m = officeCeiling(4);
    const head = m.head;
    const preview = previewAirConnect(m.head, ids(4), "ci");
    if ("refused" in preview) throw new Error(preview.refused);
    expect(m.head).toBe(head);
    expect(preview.joinable).toBe(4);
    expect(preview.lines.map((l) => l.text)).toEqual(Array.from({ length: 4 }, (_, i) => expect.stringMatching(new RegExp(`^SD-${i + 1} neck → Supply Air 1: .*ft flex$`))));
  });

  it("connects every selected diffuser as one edit: one tap per diffuser on the trunk, flex into each neck", () => {
    const m = officeCeiling(4);
    const preview = previewAirConnect(m.head, ids(4), "ci");
    if ("refused" in preview) throw new Error(preview.refused);
    const before = m.log.length;
    for (const command of preview.plan.commands) m.ok(command);
    expect(m.log.length).toBe(before + 1);
    for (const id of ids(4)) expect(m.part(id).links?.neck?.elementId).toMatch(/^ci-\d-flex$/);
    expect(m.takeoffsOn("trunk-s1")).toHaveLength(4);
    expect(validateModel(m.head)).toEqual([]);
  });

  it("no nearby open round end is needed (round 14 refused a diffuser with no matching branch end)", () => {
    const m = officeCeiling(1);
    // Nothing but the rectangular trunk: no round branch end anywhere near the diffuser.
    expect(m.segs().filter((s) => s.size.shape === "round")).toEqual([]);
    const preview = previewAirConnect(m.head, ["sd-1"], "ci");
    if ("refused" in preview) throw new Error(preview.refused);
    expect(preview.joinable).toBe(1);
  });

  it("says why it is off: nothing selected, no duct connection, already connected", () => {
    const m = officeCeiling(1);
    expect(airConnectBlocked(m.head.elements, [])).toBe(AIR_CONNECT_WORDS.selectFirst);
    expect(airConnectBlocked(m.head.elements, ["trunk-s1"])).toBe(AIR_CONNECT_WORDS.selectFirst);
    expect(airConnectBlocked(m.head.elements, ["sd-1"])).toBeNull();
    const preview = previewAirConnect(m.head, ["sd-1"], "ci");
    if ("refused" in preview) throw new Error(preview.refused);
    for (const command of preview.plan.commands) m.ok(command);
    expect(airConnectSources(m.head.elements, ["sd-1"])).toEqual([]);
    expect(airConnectBlocked(m.head.elements, ["sd-1"])).toBe(AIR_CONNECT_WORDS.allConnected);
  });

  it("a diffuser with no duct of its system in reach is named with the reason; the others still connect", () => {
    const m = officeCeiling(2);
    m.place("far", DIFFUSER, 0, 200 * FT, 8 * FT, "SD-9");
    const preview = previewAirConnect(m.head, [...ids(2), "far"], "ci");
    if ("refused" in preview) throw new Error(preview.refused);
    expect(preview.joinable).toBe(2);
    expect(preview.lines.find((l) => l.elementId === "far")?.text).toMatch(/No run of the same system is within 100 ft/);
  });
});

describe("the + grip on a diffuser, through the mechanical add-on's row", () => {
  it("offers the supply trunk and drops as one connect_into (round 14's row answered nothing)", () => {
    withPackSet(PackSet.create([MECHANICAL_PACK]), () => {
      const m = officeCeiling(1);
      const answer = sourcesFor(m.head, { elementId: asElementId("sd-1") });
      if (!answer) throw new Error("the mechanical row offered nothing for a diffuser");
      expect(answer.candidates.map((c) => c.sourceId)).toEqual(["trunk-s1"]);
      const pick = answer.candidates[0];
      if (!pick) throw new Error("no candidate");
      const plan = connectToSource(m.head, { elementId: asElementId("sd-1") }, pick, "grip1");
      if (!plan.ok) throw new Error(plan.reason);
      expect(plan.commands.map((c) => c.type)).toEqual(["connect_into"]);
      for (const command of plan.commands) m.ok(command);
      expect(m.part("sd-1").links?.neck).toBeDefined();
    });
  });
});
