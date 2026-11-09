/**
 * @jest-environment node
 *
 * Round 13 lane P13: Plumbing › Systems › Sewer connection. With the building
 * drain selected, a new manhole (invert and rim typed) is placed past its open
 * end and the drain is routed on to its inlet; the walk then reaches it and
 * reads the manhole's invert and rim. Picking an existing manhole needs a free
 * inlet. A selection that isn't an open-ended pipe says what to select.
 *
 * Fails on round 12's code: there was no way to take a drawn drain to a sewer
 * connection (`outfallConnectionCommands`), and the walk stopped at the drain.
 */
import { asElementId } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { PLUMBING_GAS_PACK, outfallConnectionBlocked, outfallConnectionChoices, outfallConnectionCommands, outfallWalk, type OutfallConnectionPlan } from "../src";
import { FT, SewerSite } from "./p13-fixtures";

function drained(): SewerSite {
  const s = new SewerSite();
  s.drawDrain();
  return s;
}

const lastOf = (s: SewerSite) => {
  const id = s.segments[s.segments.length - 1];
  if (!id) throw new Error("no drain");
  return id;
};

function apply(s: SewerSite, plan: OutfallConnectionPlan | { readonly refused: string }): void {
  if ("refused" in plan) throw new Error(plan.refused);
  for (const c of plan.first) s.ok(c);
  const next = plan.next?.(s.head) ?? [];
  if ("refused" in next) throw new Error(next.refused);
  for (const c of next) s.ok(c);
}

describe("p13-sewer-connection-command", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("a new manhole past the open end, routed to: the walk ends there with its invert and rim", () => {
    const s = drained();
    const cmds = outfallConnectionCommands(s.head, lastOf(s), { kind: "new", partId: "mh-3", mark: "MH-3", invertMm: -20 * FT, rimMm: -14 * FT }, "sc");
    apply(s, cmds);
    const walk = outfallWalk(s.head, s.segments[0] ?? asElementId("none"));
    expect(walk.outfall).toMatchObject({ elementId: "mh-3", label: "MH-3", invertMm: -20 * FT, rimMm: -14 * FT });
    expect(outfallConnectionChoices(s.head).map((c) => c.label)).toEqual(["MH-3"]);
  });

  it("an existing manhole is routed to only through a free inlet, and says why not otherwise", () => {
    const s = drained();
    s.manhole({ invertFt: -20, rimFt: -14 });
    expect(outfallConnectionCommands(s.head, lastOf(s), { kind: "existing", manholeId: asElementId("mh-1") }, "sc")).toEqual({ refused: "MH-1 has no inlet to connect a drain to: enter a new manhole instead, or use a manhole type with an inlet." });
    apply(s, outfallConnectionCommands(s.head, lastOf(s), { kind: "new", partId: "mh-3", mark: "MH-3", invertMm: null, rimMm: null }, "sc"));
    const again = outfallConnectionCommands(s.head, lastOf(s), { kind: "existing", manholeId: asElementId("mh-3") }, "sc2");
    expect("refused" in again ? again.refused : null).toMatch(/^(MH-3's inlet already takes a drain|Both ends of this pipe already connect)/);
  });

  it("says what to select when the selection can't start one", () => {
    const s = drained();
    expect(outfallConnectionBlocked(s.head, [])).toBe("Select the building drain where it leaves the building, then press Sewer connection.");
    expect(outfallConnectionBlocked(s.head, [lastOf(s)])).toBeNull();
  });
});
