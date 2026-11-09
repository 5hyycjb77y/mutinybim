/**
 * @jest-environment node
 *
 * No drain a water closet discharges to is smaller than 3 in.: the building
 * drain by Table 710.1(1) note a, a horizontal branch or stack by 704.2 (the
 * closet's 3 in. connection is not reduced downstream). Found Nov 7, 2026:
 * size_drain held only the building drain to it, so a 10 DFU branch with a
 * water closet came back 2-1/2 in. The answer is a number (size_nominal_in)
 * beside the printed size (size_in), cited, in every edition the code pack
 * holds (2021: Virginia's text, and the same tables under another state's
 * adoption).
 */
import { builtinCalcRegistry, IPC_EDITIONS, type CalcRun } from "@permitzip/bim-calc";

const registry = builtinCalcRegistry();

function run(inputs: Record<string, unknown>, where: Record<string, unknown> = { state: "VA" }): CalcRun {
  const r = registry.run({ calc: "plumbing.size_drain", inputs, ...where });
  if (!r.ok) throw new Error(r.reason);
  return r.run;
}
const value = (r: CalcRun, key: string) => r.values.find((v) => v.key === key);
const sizes = (r: CalcRun) => ({ text: value(r, "size_in")?.value, inches: value(r, "size_nominal_in")?.value });
const citesOf = (r: CalcRun, key: string) => value(r, key)?.cite.map((c) => c.clause) ?? [];

describe("plumbing.size_drain: 3 in. minimum with a water closet", () => {
  it("the code pack holds 2021 only, so 2021 is every edition tested", () => {
    expect([...IPC_EDITIONS]).toEqual(["2021"]);
  });

  for (const where of [{ state: "VA" }, { state: "MD" }, { plumbingEdition: "2021" }] as const) {
    const name = Object.values(where)[0];
    describe(`under ${name}`, () => {
      it("a horizontal branch that a water closet drains to is 3 in., not the table's 2-1/2 in., and says why", () => {
        const r = run({ role: "horizontal_branch", dfu: 10, serves_water_closet: true }, where);
        expect(sizes(r)).toEqual({ text: "3", inches: 3 });
        expect(citesOf(r, "size_nominal_in")).toEqual(["Table 710.1(2)", "704.2"]);
        expect(r.steps.find((s) => s.label === "Water closet")?.detail).toBe("2-1/2 in. carries 10 DFU, but it serves a water closet: 3 in. minimum");
      });

      it("a 2 in. stack with a water closet on it is 3 in.", () => {
        const r = run({ role: "stack", dfu: 10, serves_water_closet: true }, where);
        expect(sizes(r)).toEqual({ text: "3", inches: 3 });
        expect(citesOf(r, "size_in")).toContain("704.2");
      });

      it("a lavatory-only branch keeps the table's size", () => {
        const r = run({ role: "horizontal_branch", fixtures: [{ fixture: "Lavatory", quantity: 2 }] }, where);
        expect(sizes(r)).toEqual({ text: "1-1/2", inches: 1.5 });
        expect(citesOf(r, "size_in")).toEqual(["Table 710.1(2)"]);
        expect(r.steps.some((s) => s.label === "Water closet")).toBe(false);
      });

      it("a branch already 3 in. or bigger is not changed, only cited", () => {
        const r = run({ role: "horizontal_branch", dfu: 100, serves_water_closet: true }, where);
        expect(sizes(r)).toEqual({ text: "4", inches: 4 });
        expect(r.steps.some((s) => s.label === "Water closet")).toBe(false);
      });

      it("the building drain cites note a and answers in numbers too", () => {
        const r = run({ role: "building_drain", dfu: 4, slope_in_per_ft: 0.25, serves_water_closet: true }, where);
        expect(sizes(r)).toEqual({ text: "3", inches: 3 });
        expect(citesOf(r, "size_in")).toEqual(["Table 710.1(1)", "Table 704.1", "Table 710.1(1), note a"]);
        const bare = run({ role: "building_drain", dfu: 4, slope_in_per_ft: 0.25 }, where);
        expect(value(bare, "size_nominal_in")?.value).toBeLessThan(3);
      });

      it("a drawn 2 in. branch under a water closet fails the check", () => {
        const r = run({ role: "horizontal_branch", dfu: 6, serves_water_closet: true, actual_in: 2 }, where);
        expect(value(r, "pass")?.value).toBe(false);
        expect(r.issues.find((i) => i.severity === "error")?.message).toBe("The drawn 2 in. is smaller than the required 3 in.");
      });
    });
  }
});

describe("other plumbing sizing calcs answer a number beside the printed size", () => {
  it("water pipe sizing: size_nominal_in:<segment> matches size:<segment>", () => {
    const r = registry.run({ calc: "plumbing.size_water", inputs: registry.get("plumbing.size_water")?.info.example, state: "VA" });
    if (!r.ok) throw new Error(r.reason);
    const printed = r.run.values.filter((v) => v.key.startsWith("size:"));
    expect(printed.length).toBeGreaterThan(0);
    const labels: Record<number, string> = { 0.375: "3/8", 0.5: "1/2", 0.75: "3/4", 1: "1", 1.25: "1-1/4", 1.5: "1-1/2", 2: "2", 2.5: "2-1/2", 3: "3" };
    for (const v of printed) {
      const n = r.run.values.find((x) => x.key === `size_nominal_in:${v.key.slice(5)}`)?.value;
      expect([v.key, typeof n === "number" ? labels[n] : n]).toEqual([v.key, v.value]);
    }
  });

  it("gas pipe sizing (steel table): size_nominal_in:<segment> for every sized segment", () => {
    const r = registry.run({ calc: "plumbing.size_gas", inputs: registry.get("plumbing.size_gas")?.info.example, state: "VA" });
    if (!r.ok) throw new Error(r.reason);
    const printed = r.run.values.filter((v) => v.key.startsWith("size:") && v.value !== null);
    expect(printed.length).toBeGreaterThan(0);
    for (const v of printed) expect(typeof r.run.values.find((x) => x.key === `size_nominal_in:${v.key.slice(5)}`)?.value).toBe("number");
  });
});
