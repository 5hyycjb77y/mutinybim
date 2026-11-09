/**
 * @jest-environment node
 *
 * The plumbing lint pack (ROADMAP P5): grease routing by sewer authority and
 * the base-of-stack check. Each rule fires on its fixture, says what to do in
 * plain words, and clears on the fix. The pack did not exist before this
 * change: nothing anywhere checked where a three-compartment sink drains, so
 * every "fires" case fails on the old code (no rule, nothing to import).
 */
import { type ModelState, type ParamDef, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { stacksOf } from "@permitzip/bim-pack-plumbing";
import { STACK_SAN, stackRisers } from "../../bim-kernel/__tests__/fixtures/stack-risers";
import { activeLintRules, DEFAULT_LINT_CONFIG, LintEngine, type Finding } from "@permitzip/bim-lint";
import { plumbingRules } from "../src/lint/plumbing";
import { DrainageBuilding, FT, SEWER_CONNECTION } from "../../bim-kernel/__tests__/drainage-fixtures";

const text = (name: string, label: string): ParamDef => ({ name, label, kind: "text" });

/** The test's manhole type, with the two authority values the starter library now carries. */
const SEWER_WITH_AUTHORITY: PartTypeDefinition = { ...SEWER_CONNECTION, instanceParams: [...SEWER_CONNECTION.instanceParams, text("sewer_authority", "Sewer authority"), text("grease_fixtures", "Fixtures to the grease interceptor")] };

const GREASE_INTERCEPTOR: PartTypeDefinition = {
  familyName: "Grease interceptor",
  typeName: "50 gpm",
  category: "pipe_accessory",
  typeParams: [text("plumbing_source", "Plumbing source")],
  typeValues: { plumbing_source: "grease_interceptor" },
  instanceParams: [],
  tagFields: [],
  geometry: [{ kind: "box", center: [0, 0, 300], size: [600, 600, 600] }],
  symbol: [{ kind: "rect", center: [0, 0], size: [600, 600] }],
  connectors: [],
  source: { kind: "builtin", libraryVersion: "test" },
};

function findings(model: ModelState, rules = plumbingRules): Finding[] {
  const e = new LintEngine(rules);
  e.build(model, []);
  return e.check({ config: { ...DEFAULT_LINT_CONFIG, ruleset: "issue" } });
}

function fired(model: ModelState): string[] {
  return findings(model)
    .map((f) => `${f.rule} ${f.elementIds[0]}`)
    .sort();
}

/** 7329-shaped kitchen rows: a three-compartment sink, a hand sink, a mop sink and a restroom water closet, typed as loads before any pipe. */
function kitchen(values: Record<string, string> | null): DrainageBuilding {
  const b = new DrainageBuilding();
  if (values) b.ok({ type: "place_part", partId: "mh-1", typeId: "type-mh-auth", partType: SEWER_WITH_AUTHORITY, levelId: "lvl-1", position: { x: 40 * FT, y: 0 }, mark: "MH-1", values });
  b.ok({ type: "place_part", partId: "gi-1", typeId: "type-gi", partType: GREASE_INTERCEPTOR, levelId: "lvl-1", position: { x: 20 * FT, y: 0 }, mark: "GI-1", values: {} });
  b.ok({
    type: "create_load",
    loads: [
      { id: "sk3", mark: "P434A-1", note: "Three compartment sink", values: { dfu: 3 } },
      { id: "hs", mark: "P41-1", note: "Hand sink", values: { dfu: 3 } },
      { id: "ms", mark: "MS-1", note: "Mop sink", values: { dfu: 3 } },
      { id: "wc", mark: "WC-1", note: "Water closet, ADA", values: { dfu: 5 } },
    ],
  });
  return b;
}

describe("base-of-stack check (STATUS decision 10: off until turned on)", () => {
  const pvc = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * 25.4, material: "pvc" as const });

  function stackWithBranchOnDrain(yFt: number) {
    const b = stackRisers();
    // The fixture's base cleanout sits 2 ft down the drain; take it out to make room for the branch under test.
    b.ok({ type: "delete_elements", ids: ["co-base"], policy: "disconnect" });
    const san = stacksOf(b.head.elements).stacks.find((s) => s.systemId === STACK_SAN.id);
    const drainId = san?.chain.base?.drainId;
    if (!drainId) throw new Error("the fixture's stack has no base bend");
    const drain = b.head.elements[drainId];
    if (drain?.kind !== "run_segment") throw new Error("no drain");
    const z = drain.start.z + ((drain.end.z - drain.start.z) * Math.abs(yFt * FT - drain.start.y)) / Math.max(1, Math.abs(drain.end.y - drain.start.y));
    b.ok({ type: "route_run", idPrefix: "near", levelId: drain.levelId, domain: "pipe", size: pvc(2), elevationMm: z, system: STACK_SAN, points: [{ x: 4 * FT, y: yFt * FT }, { x: drain.start.x, y: yFt * FT }], to: { kind: "run_branch", segmentId: drainId } });
    return b;
  }

  it("is off by default: a branch 6 in. past the base bend says nothing, and the rule says how to turn it on", () => {
    const b = stackWithBranchOnDrain(-1.5);
    expect(findings(b.head).filter((f) => f.rule === "stack-base-branch-too-close")).toEqual([]);
    const e = new LintEngine(plumbingRules);
    e.build(b.head, []);
    expect(e.availability({ ...DEFAULT_LINT_CONFIG, ruleset: "issue" }).find((r) => r.rule === "stack-base-branch-too-close")).toMatchObject({ available: false, reason: "Off by default (a firm rule, not code): turn it on in Plumbing › Stacks" });
  });

  // The base bend is a 4" long sweep (r/D 3), so its end is a foot down the drain; distances are measured from there.
  it("turned on: a branch within 3 pipe diameters (12 in. on a 4 in. stack) of where the bend ends fires; one 3 ft out doesn't", () => {
    const near = stackWithBranchOnDrain(-1.5);
    near.ok({ type: "set_stack_checks", baseClearanceDiameters: 3 });
    const hit = findings(near.head).filter((f) => f.rule === "stack-base-branch-too-close");
    expect(hit).toHaveLength(1);
    expect(hit[0]?.severity).toBe("warning");
    expect(hit[0]?.message).toMatch(/^A branch joins on the pipe leaving the stack's base bend \d+'-\d+" from the base bend; keep it 3 pipe diameters \(1'-0"\) away \(firm rule\)$/);
    expect(hit[0]?.fix?.tool).toBe("bim_slide_branch");

    const far = stackWithBranchOnDrain(-3);
    far.ok({ type: "set_stack_checks", baseClearanceDiameters: 3 });
    expect(findings(far.head).filter((f) => f.rule === "stack-base-branch-too-close")).toEqual([]);

    // Turned off again, it clears.
    near.ok({ type: "set_stack_checks", baseClearanceDiameters: null });
    expect(findings(near.head).filter((f) => f.rule === "stack-base-branch-too-close")).toEqual([]);
  });
});

describe("grease routing by sewer authority", () => {
  it("with no sewer connection, only the three-compartment sink is flagged, and as 'unknown authority', not a guess", () => {
    const b = kitchen(null);
    const f = findings(b.head);
    expect(f.map((x) => `${x.rule} ${x.elementIds[0]}`)).toEqual(["grease-authority-unknown sk3"]);
    expect(f[0]?.message).toBe("P434A-1 carries grease (IPC 1003.3.1); sewer authority unknown: place the sewer connection and set its authority from the code study");
    expect(f[0]?.severity).toBe("info");
    expect(f[0]?.fix?.tool).toBe("bim_set_parameters");
  });

  it("a manhole with no authority typed says where to type it", () => {
    const f = findings(kitchen({}).head);
    expect(f.map((x) => x.message)).toEqual(["P434A-1 carries grease (IPC 1003.3.1); sewer authority unknown: set it on MH-1 from the code study"]);
  });

  it("HRSD: every fixture but the restroom's must go through the interceptor; naming GI-1 clears one, naming the manhole is an error", () => {
    const b = kitchen({ sewer_authority: "HRSD" });
    expect(fired(b.head)).toEqual(["grease-fixture-not-routed hs", "grease-fixture-not-routed ms", "grease-fixture-not-routed sk3"]);
    const sink = findings(b.head).find((x) => x.elementIds[0] === "sk3");
    expect(sink?.message).toBe("P434A-1 (three-compartment sink) must drain through a grease interceptor under HRSD (HRSD FOG program; IPC 1003.3.1); none is piped or named yet");

    b.ok({ type: "edit_load_point", loadId: "sk3", servedBy: "gi-1" });
    b.ok({ type: "edit_load_point", loadId: "ms", servedBy: "gi-1" });
    b.ok({ type: "edit_load_point", loadId: "hs", servedBy: "mh-1" });
    const f = findings(b.head);
    expect(f.map((x) => `${x.rule} ${x.elementIds[0]}`)).toEqual(["grease-fixture-bypasses-interceptor hs"]);
    expect(f[0]?.severity).toBe("error");
    expect(f[0]?.message).toBe("P41-1 (hand sink) drains to MH-1 (its named source) without a grease interceptor; HRSD sends it through one (HRSD FOG program; IPC 1003.3.1)");
    expect(f[0]?.elementIds).toEqual(["hs", "mh-1"]);

    b.ok({ type: "edit_load_point", loadId: "hs", servedBy: "gi-1" });
    expect(findings(b.head)).toEqual([]);
  });

  it("Henrico County DPU (7329): only the three-compartment sink goes to the interceptor", () => {
    const b = kitchen({ sewer_authority: "Henrico County DPU" });
    expect(fired(b.head)).toEqual(["grease-fixture-not-routed sk3"]);
  });

  it("an authority with no rule on file says so, and a project rule typed on the manhole is used instead of guessing", () => {
    const b = kitchen({ sewer_authority: "Town of Nowhere" });
    expect(findings(b.head).map((x) => x.message)).toEqual(["P434A-1 carries grease (IPC 1003.3.1); no grease rule is on file for Town of Nowhere; type which fixtures go to the interceptor on MH-1"]);
    b.ok({ type: "set_parameters", id: "mh-1", scope: "instance", values: { grease_fixtures: "three compartment sink, mop sink" } });
    expect(fired(b.head)).toEqual(["grease-fixture-not-routed ms", "grease-fixture-not-routed sk3"]);
    expect(findings(b.head)[0]?.message).toContain("under Town of Nowhere (Town of Nowhere, as set on the project; IPC 1003.3.1)");
  });

  it("is in the engine's rule list, so Coordination and the agent's lint returns show it", () => {
    const ids = activeLintRules().map((r) => r.id);
    for (const r of ["grease-fixture-bypasses-interceptor", "grease-fixture-not-routed", "grease-authority-unknown", "stack-base-branch-too-close"]) expect(ids).toContain(r);
    const b = kitchen({ sewer_authority: "HRSD" });
    expect(findings(b.head, activeLintRules()).filter((f) => f.rule === "grease-fixture-not-routed")).toHaveLength(3);
  });
});
