/**
 * @jest-environment node
 *
 * Round 6 lane P: the four kernel points generic pipe code reads where it
 * used to import Plumbing and gas (`SYSTEM_LABEL_POINT`, `PIPE_RUN_CHECK_POINT`,
 * `SERVES_RULE_POINT`, `STARTER_CONNECTION_TYPE_POINT`). A test pack's row
 * reaches each reader inside its own set only; the first-party rows keep
 * answering first. Before round 6 the run label, the run checks, the serves
 * walk and the starter catalog were fixed imports of the plumbing slice: no
 * pack row could reach them.
 */
import {
  PIPE_RUN_CHECK_POINT,
  SERVES_RULE_POINT,
  STARTER_CONNECTION_TYPE_POINT,
  SYSTEM_LABEL_POINT,
  connectionTypeSchema,
  elementsOfKind,
  pipeRoutingIssues,
  servesOf,
  sourceOf,
  starterConnectionType,
  systemKindLabel,
  type ElementId,
  type RunIssue,
} from "@permitzip/bim-kernel";
import { PackSet, contribute, definePack, withPackSet } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas, SAMPLE_MARKET_GAS_SYSTEM } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";

const model = buildSampleMarketGas();
const gasSystem = elementsOfKind(model.elements, "mep_system").find((s) => s.id === SAMPLE_MARKET_GAS_SYSTEM);
const pipe = elementsOfKind(model.elements, "run_segment").find((s) => s.systemId === SAMPLE_MARKET_GAS_SYSTEM);
const part = elementsOfKind(model.elements, "part")[0];

const ZZ_ISSUE: RunIssue = { code: "invalid_value", message: "zz: this pipe is checked by a test pack", elementIds: [] };
const ZZ_STARTER = connectionTypeSchema.parse({ type: "connection_type", designator: "ZZ-1", trade: "plumbing", description: "Test fixture", quantities: { dfu: 1 } });

const ZZ = definePack({ id: "zz", name: "Zed", version: "1.0.0", kernel: "^1.3.0" }, [
  contribute(SYSTEM_LABEL_POINT, [{ id: "zz.medium", label: (system) => (system.systemKind === "domestic_cold_water" ? "Zed water" : null) }]),
  contribute(PIPE_RUN_CHECK_POINT, [{ id: "zz.check", segment: () => [ZZ_ISSUE] }]),
  contribute(SERVES_RULE_POINT, [{ id: "zz.serves", rank: 90, served: (_elements, id) => (part && id === part.id && pipe ? [pipe.id] : []), sourceOf: (_elements, id) => (pipe && id === pipe.id && part ? part.id : null) }]),
  contribute(STARTER_CONNECTION_TYPE_POINT, [ZZ_STARTER]),
]);
const zzSet = PackSet.create([ZZ]);
const other = PackSet.create([]);

describe("generic pipe code reads Plumbing and gas through points", () => {
  it("has the fixture it reads", () => {
    expect(gasSystem && pipe && part).toBeTruthy();
  });

  it("system words: the first-party gas row answers first, a pack's row only in its set", () => {
    if (!gasSystem) throw new Error("no gas system");
    const water = { ...gasSystem, systemKind: "domestic_cold_water" as const };
    // The 7492 fixture burns propane: the gas row names the fuel, not the kind's word ("Natural gas").
    expect(withPackSet(zzSet, () => systemKindLabel(gasSystem))).toBe("Propane");
    expect(withPackSet(zzSet, () => systemKindLabel(water))).toBe("Zed water");
    expect(withPackSet(other, () => systemKindLabel(water))).toBe("Domestic cold water");
  });

  it("pipe run checks: a pack's segment check joins the shared checks in its set only", () => {
    if (!pipe) throw new Error("no pipe");
    const run = (set: PackSet) => withPackSet(set, () => {
      const issues: RunIssue[] = [];
      pipeRoutingIssues(model.elements, pipe, model.settings, issues);
      return issues.map((i) => i.message);
    });
    expect(run(zzSet)).toContain(ZZ_ISSUE.message);
    expect(run(other)).not.toContain(ZZ_ISSUE.message);
  });

  it("serves: a pack's walk adds what it serves and an outlet's source, in its set only", () => {
    if (!pipe || !part) throw new Error("no fixture");
    expect(withPackSet(zzSet, () => servesOf(model.elements, part))).toContain(pipe.id);
    expect(withPackSet(other, () => servesOf(model.elements, part))).not.toContain(pipe.id);
    expect(withPackSet(zzSet, () => sourceOf(model.elements, pipe))).toBe(part.id as ElementId);
  });

  it("starter connection types: the first-party starters everywhere, a pack's in its set", () => {
    expect(withPackSet(other, () => starterConnectionType("WC-FT")?.description)).toBe("Water closet, flush tank");
    expect(withPackSet(zzSet, () => starterConnectionType("zz-1")?.designator)).toBe("ZZ-1");
    expect(withPackSet(other, () => starterConnectionType("ZZ-1"))).toBeNull();
  });
});
