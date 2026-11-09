/**
 * @jest-environment node
 *
 * Round 13 lane P13: the sewer walk's findings reach the Checklist as the
 * `sewer-walk` rule on the sewer connection (Select highlights the pipe; the
 * hint names the fix), and each fix is a command that places the starter
 * sewage ejector or backwater valve on that pipe's level at its height. A
 * manhole nothing drawn reaches says nothing (the floor-based rules cover it).
 *
 * Fails on round 12's code: no rule read the drawn drain to the manhole, and
 * there was no fix command (`outfallWalkFindingsAt`, `outfallFixCommand`).
 */
import { asElementId, type ModelState } from "@permitzip/bim-kernel";
import { installFirstPartyPacks } from "@permitzip/bim-kernel/packs";
import { DEFAULT_LINT_CONFIG, LintEngine, type Finding } from "@permitzip/bim-lint";
import { PLUMBING_GAS_PACK, OUTFALL_FIX_TYPE_IDS, drainageRoleOf, outfallFixCommand, outfallWalkFindingsAt } from "../src";
import { drainageRules } from "../src/lint/drainage";
import { SewerSite } from "./p13-fixtures";

function walkFindings(model: ModelState): Finding[] {
  const e = new LintEngine(drainageRules);
  e.build(model, []);
  return e.check({ config: { ...DEFAULT_LINT_CONFIG, ruleset: "issue" } }).filter((f) => f.rule === "sewer-walk");
}

function site(rimFt: number, linked = true): SewerSite {
  const s = new SewerSite();
  s.manhole({ invertFt: -12, rimFt });
  s.drawDrain();
  s.slope([
    [-300, -400],
    [-400, -500],
  ]);
  if (linked) s.linkToPart("mh-1");
  return s;
}

describe("p13-sewer-walk-checklist", () => {
  beforeAll(() => installFirstPartyPacks([PLUMBING_GAS_PACK]));

  it("the Basement below MH-1's rim shows once in the Checklist, selecting its branch, with the valve fix", () => {
    const s = site(-2);
    const found = walkFindings(s.head);
    expect(found.map((f) => [f.severity, f.message, f.elementIds])).toEqual([["warning", "Fixtures on Basement sit below MH-1's rim: a backwater valve is required on their branch", [s.segments[0], "mh-1"]]]);
    expect(found[0]?.fix?.hint).toBe(`Place a backwater valve: the starter backwater valve on pipe ${s.segments[0]}, then connect it`);
  });

  it("a manhole nothing drawn reaches, or a drain that clears it, adds nothing", () => {
    expect(walkFindings(site(-2, false).head)).toEqual([]);
    expect(walkFindings(site(-14).head)).toEqual([]);
  });

  it("the fix places the starter backwater valve halfway along the branch, at its height", () => {
    const s = site(-2);
    const fix = outfallWalkFindingsAt(s.head, asElementId("mh-1"))[0]?.fix;
    if (!fix) throw new Error("no fix offered");
    const cmd = outfallFixCommand(s.head, fix, "bwv-1");
    if ("refused" in cmd) throw new Error(cmd.refused);
    s.ok(cmd);
    const valve = s.head.elements["bwv-1"];
    const branch = s.head.elements[fix.at];
    if (valve?.kind !== "part" || branch?.kind !== "run_segment") throw new Error("nothing placed");
    expect(valve.typeId).toBe(OUTFALL_FIX_TYPE_IDS.backwater_valve);
    expect(drainageRoleOf(s.head.elements, valve)).toBe("backwater_valve");
    expect([valve.levelId, valve.position.x, valve.position.y]).toEqual([branch.levelId, (branch.start.x + branch.end.x) / 2, (branch.start.y + branch.end.y) / 2]);
  });

  it("a fix on a pipe that's gone says to walk again", () => {
    const s = site(-2);
    expect(outfallFixCommand(s.head, { label: "Add an ejector here", places: "ejector", at: asElementId("gone") }, "ep-9")).toEqual({ refused: "gone isn't a drawn pipe any more: walk the drain again" });
  });
});
