/**
 * @jest-environment node
 *
 * Batch 5c lane A, the multi-tenant proof: a test pack `zz`, written only
 * against `@permitzip/bim-pack`, contributes a network adapter, a
 * derived-zone rule, a service row, a lint rule and a calc. Each is seen
 * only inside its set's scope, and never by another model bound to another
 * set on the same "server" (one process). On the old code there was no way
 * to register any of them except the global maps and static arrays, which
 * reached every model in the process.
 */
import { z } from "zod";
import { DEFAULT_LINT_CONFIG, LintEngine, rulesFor } from "@permitzip/bim-lint";
import { builtinCalcRegistry } from "@permitzip/bim-calc";
import { adapterForService, derivedZoneRule, serviceById, tradeAdapter } from "@permitzip/bim-kernel";
import { activeLintRules } from "@permitzip/bim-lint";
import { CALC_POINT, CODE_EDITION_POINT, DERIVED_ZONE_RULE_POINT, LINT_RULE_POINT, NETWORK_ADAPTER_POINT, PackSet, SERVICE_POINT, AGENT_TOOL_POINT, bindModelPacks, contribute, defineCalc, definePack, describePacks, runPackConformance, unbindModelPacks, withModelPacks, withPackSet, type RuleDef, type ServiceRow, type TradeAdapter } from "../src";
import { FIRST_PARTY_ADDONS as FIRST_PARTY_PACKS } from "@permitzip/bim-first-party";
import { ELECTRICAL_POINTS } from "@permitzip/bim-pack-electrical";

const zzAdapter: TradeAdapter = { trade: "mechanical", source: () => null, connectors: () => [], positionsNeeded: () => null, refusal: () => null, positionsRefusal: () => null };

const zzService: ServiceRow = { id: "zz.slurry", label: "Slurry", discipline: "civil", medium: "liquid", regime: "pressure", connector: "pipe", adapter: "zz.slurry_flow", quantities: [], asSystem: true, asLoad: false, ifc: { system: "IfcDistributionSystem", predefinedType: "USERDEFINED", objectType: "SLURRY" } };

const zzRule: RuleDef = { id: "zz.slurry_check", version: 1, pack: "zz", severity: "info", title: "Slurry check", scope: "element", kinds: ["part"], run: () => undefined };

const zzCalc = defineCalc({
  id: "zz.double",
  version: "1.0.0",
  domain: "zz",
  title: "Double it",
  summary: "Twice the input",
  codeFamily: "zz.handbook",
  needsModel: false,
  input: z.object({ x: z.number() }),
  example: { x: 2 },
  run: (input, ctx) => ({ values: [{ key: "y", label: "Twice", value: input.x * 2, unit: null, cite: [] }], steps: [{ label: "Edition", detail: ctx.code?.edition ?? "none", cite: [] }], issues: [], detail: null }),
});

export const ZZ_PACK = definePack({ id: "zz", name: "Test pack", version: "1.0.0", kernel: "^1.0.0" }, [
  contribute(NETWORK_ADAPTER_POINT, [{ id: "zz.slurry_flow", adapter: zzAdapter }]),
  contribute(SERVICE_POINT, [zzService]),
  contribute(DERIVED_ZONE_RULE_POINT, [{ id: "zz.swing", label: "Swing clearance", ifcPredefinedType: "RESERVATION", derive: () => [] }]),
  contribute(LINT_RULE_POINT, [zzRule]),
  contribute(CALC_POINT, [zzCalc]),
  contribute(CODE_EDITION_POINT, [{ family: "zz.handbook", label: "Slurry handbook", editions: ["2024"], resolve: () => ({ ok: true, code: { family: "zz.handbook", code: "SH", edition: "2024", packVersion: "1", clauses: {}, tables: null }, step: null }) }]),
  contribute(AGENT_TOOL_POINT, [{ name: "zz_double", title: "Double it", description: "Doubles a number", input: { type: "object", properties: { x: { type: "number" } }, required: ["x"] }, permission: "read", target: { kind: "read", read: "zz.double" } }]),
]);

const withZz = PackSet.create([...FIRST_PARTY_PACKS, ZZ_PACK]);
const without = PackSet.create([...FIRST_PARTY_PACKS]);
const calcs = builtinCalcRegistry();

function seen() {
  return {
    adapter: tradeAdapter("zz.slurry_flow") === zzAdapter,
    walked: adapterForService("zz.slurry") === zzAdapter,
    service: serviceById("zz.slurry")?.label ?? null,
    rule: derivedZoneRule("zz.swing")?.label ?? null,
    lint: activeLintRules().includes(zzRule),
    lintRuns: rulesFor(activeLintRules(), DEFAULT_LINT_CONFIG).includes(zzRule),
    calc: calcs.get("zz.double") !== null,
  };
}

const NONE = { adapter: false, walked: false, service: null, rule: null, lint: false, lintRuns: false, calc: false };
const ALL = { adapter: true, walked: true, service: "Slurry", rule: "Swing clearance", lint: true, lintRuns: true, calc: true };

describe("c5p a pack's rows reach only the models bound to its set", () => {
  it("outside any scope: none of them", () => {
    expect(seen()).toEqual(NONE);
  });

  it("inside withPackSet: every one, and the calc runs under the pack's own code family", () => {
    withPackSet(withZz, () => {
      expect(seen()).toEqual(ALL);
      const run = calcs.run({ calc: "zz.double", inputs: { x: 21 } });
      expect(run.ok && run.run.values[0]?.value).toBe(42);
      expect(run.ok && run.run.code).toEqual({ family: "zz.handbook", edition: "2024", packVersion: "1" });
    });
    expect(calcs.run({ calc: "zz.double", inputs: { x: 1 } }).ok).toBe(false);
  });

  it("two models on one server: model A sees the pack, model B never does", () => {
    bindModelPacks("model-a", withZz);
    bindModelPacks("model-b", without);
    try {
      expect(withModelPacks("model-a", seen)).toEqual(ALL);
      expect(withModelPacks("model-b", seen)).toEqual(NONE);
      // Interleaved, as a server answering both would be.
      expect(withModelPacks("model-a", () => withModelPacks("model-b", seen))).toEqual(NONE);
      expect(withModelPacks("model-b", () => withModelPacks("model-a", seen))).toEqual(ALL);
      expect(seen()).toEqual(NONE);
    } finally {
      unbindModelPacks("model-a");
      unbindModelPacks("model-b");
    }
  });

  it("the lint engine reads the set in force on every run", () => {
    const engine = new LintEngine();
    const listed = (): readonly string[] => engine.availability(DEFAULT_LINT_CONFIG).map((r) => r.rule);
    expect(listed()).not.toContain("zz.slurry_check");
    withPackSet(withZz, () => expect(listed()).toContain("zz.slurry_check"));
  });
});

describe("c5p conformance", () => {
  it("the test pack passes", () => {
    expect(runPackConformance(ZZ_PACK)).toEqual({ ok: true, problems: [] });
  });

  it("the first-party packs pass", () => {
    for (const p of FIRST_PARTY_PACKS) expect(runPackConformance(p, { points: ELECTRICAL_POINTS })).toEqual({ ok: true, problems: [] });
  });

  it("a broken pack fails, listing every problem", () => {
    // An adapter missing a method can't be typed as a TradeAdapter; the cast builds the broken input the suite must catch.
    const broken = definePack({ id: "electrical", name: "Mine", version: "1.0.0", kernel: "^2.0.0" }, [
      contribute(NETWORK_ADAPTER_POINT, [{ id: "electrical.x", adapter: { ...zzAdapter, refusal: undefined } as unknown as TradeAdapter }]),
      contribute(LINT_RULE_POINT, [{ ...zzRule, id: "electrical.y", pack: "other" }]),
      contribute(AGENT_TOOL_POINT, [{ name: "double", title: "x", description: "", input: { type: "object", properties: {} }, permission: "read", target: { kind: "read", read: "x" } }]),
    ]);
    const r = runPackConformance(broken);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("was written for contract ^2.0.0"),
        expect.stringContaining('"electrical" is a first-party pack'),
      ]),
    );
    const withinRange = runPackConformance(definePack({ ...broken.manifest, id: "yy", kernel: "^1.0.0" }, [
      contribute(NETWORK_ADAPTER_POINT, [{ id: "yy.x", adapter: { ...zzAdapter, refusal: undefined } as unknown as TradeAdapter }]),
      contribute(LINT_RULE_POINT, [{ ...zzRule, id: "yy.y", pack: "other" }]),
      contribute(AGENT_TOOL_POINT, [{ name: "double", title: "x", description: "", input: { type: "object", properties: {} }, permission: "read", target: { kind: "read", read: "x" } }]),
    ]));
    expect(withinRange.problems).toEqual(
      expect.arrayContaining([
        "network adapter yy.x is missing refusal",
        expect.stringContaining('lint rule yy.y: pack must be "yy"'),
        expect.stringContaining('agent tool "double" must'),
        "agent tool double has no description",
      ]),
    );
  });

  it("a point this release doesn't read is reported", () => {
    const stray = definePack({ id: "nn", name: "Stray", version: "1.0.0", kernel: "^1.0.0" }, [{ pointId: "kernel.future", pointVersion: 1, pointLabel: "Future rows", items: [], idOf: null, namespaced: false }]);
    expect(runPackConformance(stray).problems).toEqual([expect.stringContaining('contributes to "kernel.future"')]);
  });
});

describe("c5p listing for Settings › MutinyBIM library › Add-ons", () => {
  it("first-party packs first, with their built-in rows counted; a missing pin is listed", () => {
    const rows = describePacks([ZZ_PACK], [{ id: "civil", version: "1.2.0" }]);
    expect(rows.map((r) => [r.id, r.firstParty, r.missing])).toEqual([
      ["electrical", true, false],
      ["plumbing_gas", true, false],
      ["mechanical", true, false],
      ["fire_protection", true, false],
      ["architecture", true, false],
      ["struct", true, false],
      ["zz", false, false],
      ["civil", false, true],
    ]);
    const electrical = rows[0];
    expect(electrical?.contributes.find((c) => c.pointId === "kernel.network_adapter")?.count).toBe(1);
    expect(electrical?.contributes.find((c) => c.pointId === "kernel.derived_zone_rule")?.count).toBe(1);
    expect(rows[6]?.contributes.map((c) => c.pointId)).toEqual(expect.arrayContaining(["kernel.network_adapter", "lint.rule", "calc.calc"]));
  });
});
