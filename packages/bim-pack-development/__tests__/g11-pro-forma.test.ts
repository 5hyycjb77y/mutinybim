/**
 * @jest-environment node
 *
 * Round 11 G11 (D3): the owner's pro forma over program areas, deal
 * assumptions and the model's quantities, with prices from the reader's own
 * cost source (`COST_SOURCE_POINT`), in the reader's process. No record holds
 * money; every record read is listed so each input's confidence can be shown
 * with `readBasis`. Fails on round 10's code: no Development add-on.
 */
import { DEFAULT_SETTINGS, type BimElement, type CostRate, type CostSourceDef, type ModelState } from "@permitzip/bim-kernel";
import { bindModelPacks, contribute, definePack, PackSet, withPackSet } from "@permitzip/bim-kernel/packs";
import { COST_SOURCE_POINT } from "@permitzip/bim-kernel";
import { readBasis } from "../../bim-kernel/src/basis/read";
import type { DesignCriteria } from "@permitzip/bim-calc";
import { DEAL_COST_SYSTEM, DEVELOPMENT_KIND, DEVELOPMENT_PACK, DEVELOPMENT_VALUE, PRO_FORMA_CALC, proForma } from "../src";

const rate = (code: string, minor: number): CostRate => ({ classification: { system: DEAL_COST_SYSTEM, code }, unitRate: { minor, currency: "USD" }, measure: DEVELOPMENT_VALUE.area, per: "m2", provenance: { ownedBy: { party: "owner-dev" }, source: "owner test assumptions", date: "2026-10-01" } });
const OWNER: CostSourceDef = {
  id: "zo.owner_book",
  party: { kind: "developer", id: "owner-dev", label: "Owner" },
  basis: "budget",
  currency: "USD",
  effectiveDate: "2026-10-01",
  visibility: { kind: "party_only" },
  // $300 rent and $80 operating cost per m² per year; $2,500 hard cost per m².
  rates: () => [rate("rent_per_area_year", 30_000), rate("operating_cost_per_area_year", 8_000), rate("cost_per_area", 250_000)],
};
const OWNER_PACK = definePack({ id: "zo", name: "Owner test prices", version: "1.0.0", kernel: "^1.8.0" }, [contribute(COST_SOURCE_POINT, [OWNER])]);
const SET = PackSet.create([DEVELOPMENT_PACK, OWNER_PACK]);
const ID = "g11-pro-forma";

const area = (id: string, m2: number, share?: number): BimElement => ({ id, kind: DEVELOPMENT_KIND.programArea, version: 1, authoredRev: {}, values: { [DEVELOPMENT_VALUE.area]: m2, [DEVELOPMENT_VALUE.use]: "Residential", ...(share !== undefined ? { [DEVELOPMENT_VALUE.rentableFraction]: share } : {}) } }) as unknown as BimElement;
const assume = (id: string, which: string, fraction?: number, basis?: object): BimElement =>
  ({ id, kind: DEVELOPMENT_KIND.dealAssumption, version: 1, authoredRev: {}, values: { [DEVELOPMENT_VALUE.assumption]: which, ...(fraction !== undefined ? { [DEVELOPMENT_VALUE.fraction]: fraction } : {}) }, ...(basis ? { provenance: { basis } } : {}) }) as unknown as BimElement;

function model(): ModelState {
  const els = [
    area("PA-1", 1000, 0.85),
    area("PA-2", 200),
    assume("DA-rent", "rent_per_area_year", undefined, { maturity: "rule_of_thumb", source: { kind: "person", ref: "Owner" } }),
    assume("DA-opex", "operating_cost_per_area_year"),
    assume("DA-cost", "cost_per_area"),
    assume("DA-vac", "vacancy", 0.05),
    assume("DA-cap", "cap_rate", 0.06, { maturity: "submitted", source: { kind: "vendor_doc", ref: "Broker opinion" }, confidence: "medium" }),
    assume("DA-soft", "soft_cost_fraction", 0.2),
    assume("DA-new", "zz.newer_assumption", 0.5),
  ];
  return { modelId: ID, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

beforeAll(() => bindModelPacks(ID, SET));

/** The calc context's design criteria: unused by the pro forma, required by the calc contract. */
const CRITERIA: DesignCriteria = { id: "g11-test", version: "1", title: "Test", electrical: { branchVoltageDropPct: 3, feederVoltageDropPct: 2, combinedVoltageDropPct: 5, powerFactor: 1, ambientC: 30 } };

describe("g11 the pro forma over intent records, priced with the reader's own list", () => {
  it("works out NOI, value, cost, margin and yield", () => {
    const m = model();
    const r = withPackSet(SET, () => proForma(m, { costSourceId: "zo.owner_book", reader: "owner-dev" }));
    expect(r.grossArea).toBe(1200);
    expect(r.rentableArea).toBe(1050);
    // Rent 1,050 m² × $300 = $315,000, 5 % vacancy → $299,250; opex 1,200 × $80 = $96,000; NOI $203,250.
    expect(r.rentCollected?.minor).toBe(29_925_000);
    expect(r.operatingCost?.minor).toBe(9_600_000);
    expect(r.noi?.minor).toBe(20_325_000);
    // Value at a 6 % cap rate: $3,387,500.
    expect(r.value?.minor).toBe(338_750_000);
    // No priced quantities (nothing drawn): hard cost from cost per m², $3,000,000; soft 20 % → $3,600,000.
    expect(r.hardCostFrom).toBe("cost_per_area");
    expect(r.hardCost?.minor).toBe(300_000_000);
    expect(r.totalCost?.minor).toBe(360_000_000);
    expect(r.margin?.minor).toBe(-21_250_000);
    expect(r.yieldOnCost).toBeCloseTo(0.05646, 4);
    expect(r.notUsed).toEqual(["DA-new"]);
  });

  it("no record holds money, and every input it read has a basis to show", () => {
    const m = model();
    for (const el of Object.values(m.elements)) expect(JSON.stringify(el)).not.toMatch(/minor|USD|30000|250000/);
    const r = withPackSet(SET, () => proForma(m, { costSourceId: "zo.owner_book", reader: "owner-dev" }));
    expect(r.used.map((u) => u.recordId).sort()).toEqual(["DA-cap", "DA-cost", "DA-opex", "DA-rent", "DA-soft", "DA-vac", "PA-1", "PA-2"]);
    const shown = r.used.map((u) => {
      const el = m.elements[u.recordId];
      const b = el ? readBasis(el) : null;
      return [u.recordId, b?.known ? b.basis.maturity : "not recorded"];
    });
    expect(Object.fromEntries(shown)).toMatchObject({ "DA-rent": "rule_of_thumb", "DA-cap": "submitted", "PA-1": "not recorded" });
  });

  it("another company can't price with the owner's list; with no list the money lines say so", () => {
    const m = model();
    expect(() => withPackSet(SET, () => proForma(m, { costSourceId: "zo.owner_book", reader: "gc-acme" }))).toThrow(/no price list "zo.owner_book" you can read/);
    const none = withPackSet(SET, () => proForma(m));
    expect(none.noi).toBeNull();
    expect(none.missing).toContain("No price list chosen, so no money lines");
  });

  it("runs as the add-on's calc", () => {
    const out = withPackSet(SET, () => PRO_FORMA_CALC.execute({ costSourceId: "zo.owner_book", reader: "owner-dev" }, { code: null, criteria: CRITERIA, model: model() }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output.values.find((v) => v.key === "value")?.value).toBe("$3,387,500.00");
    const noModel = PRO_FORMA_CALC.execute({}, { code: null, criteria: CRITERIA, model: null });
    expect(noModel.ok && noModel.output.issues[0]?.message).toMatch(/open a model first/);
  });
});
