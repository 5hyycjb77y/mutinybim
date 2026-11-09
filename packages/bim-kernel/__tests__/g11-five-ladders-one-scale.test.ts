/**
 * @jest-environment node
 *
 * Round 11 G11 (D4): one confidence scale replaces five ladders. Each old
 * ladder reads onto the scale (a load's stage, a price list's basis, a
 * product's layer, a determination's confidence, a rule's verification), and
 * the stored bytes never change. A pack adds its own rung and maps its own
 * ladder with no kernel edit. Fails on round 10's code: there is no scale.
 */
import type { BimElement } from "../src";
import { contribute, definePack, PackSet } from "../src/packs";
import { ladderBasis, readBasis } from "../src/basis/read";
import { BASIS_POINT, BUILTIN_BASIS_ROWS, basisRowProblems, basisTable, KNOWN_BASIS_LADDERS } from "../src/basis/types";

const load = (id: string, extra: Readonly<Record<string, unknown>>): BimElement => ({ id, kind: "load_point", version: 1, authoredRev: {}, quantities: { va: 1000 }, ...extra }) as unknown as BimElement;
const determination: BimElement = { id: "D-1", kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "space", id: "S1" }, key: "hazard", value: "light", inputs: [], reasoning: "Synthetic.", decidedBy: "K. Example", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "medium", status: "recorded" } } as unknown as BimElement;
const rule = (status: string): BimElement =>
  ({ id: `R-${status}`, kind: "rule", version: 1, authoredRev: {}, rule: { ruleId: `r-${status}`, provider: "local", citation: { instrument: "Test Building Code", edition: "2024", section: "T-1" }, title: "Test", summary: "Synthetic.", discipline: "architecture", applies: {}, reads: [], produces: [], verification: { status, by: "Test author" } } }) as unknown as BimElement;

function reading(el: BimElement): unknown {
  const r = readBasis(el);
  return r.known ? { ...r.basis, from: r.from } : r.words;
}

describe("g11 five ladders read onto one scale", () => {
  it("built-in rungs are earliest first and every old ladder maps", () => {
    const t = basisTable(PackSet.create([]));
    expect(t.rows.map((r) => r.id)).toEqual(["assumed", "rule_of_thumb", "calculated", "selected", "submitted", "installed", "measured", "field_verified"]);
    expect(basisRowProblems(BUILTIN_BASIS_ROWS)).toEqual([]);
    for (const ladder of KNOWN_BASIS_LADDERS) expect(BUILTIN_BASIS_ROWS.some((r) => (r.maps ?? []).some((m) => m.ladder === ladder))).toBe(true);
  });

  it("load stage: estimate, concentrated, device", () => {
    expect(reading(load("LP-1", { anchor: { kind: "space", id: "S1" } }))).toEqual({ maturity: "rule_of_thumb", from: "load_stage" });
    expect(reading(load("LP-2", { anchor: { kind: "point", levelId: "L1", position: { x: 0, y: 0 } } }))).toEqual({ maturity: "calculated", from: "load_stage" });
    expect(reading(load("LP-3", { anchor: { kind: "part", partId: "P-1" } }))).toEqual({ maturity: "selected", from: "load_stage" });
  });

  it("determination confidence and rule verification, with who and when", () => {
    expect(reading(determination)).toEqual({ maturity: "selected", confidence: "medium", source: { kind: "person", ref: "K. Example" }, at: "2026-10-30T15:00:00.000Z", from: "determination_confidence" });
    expect(reading(rule("agent_found"))).toEqual({ maturity: "assumed", source: { kind: "agent", ref: "Test author" }, from: "rule_verification" });
    expect(reading(rule("verified"))).toEqual({ maturity: "calculated", source: { kind: "person", ref: "Test author" }, from: "rule_verification" });
    expect(reading(rule("invalidated"))).toEqual({ maturity: "assumed", confidence: "low", source: { kind: "person", ref: "Test author" }, from: "rule_verification" });
  });

  it("cost basis and product layer read the same way", () => {
    const set = PackSet.create([]);
    const b = (ladder: string, value: string) => {
      const r = ladderBasis(ladder, value, {}, set);
      return r.known ? r.basis.maturity : r.words;
    };
    expect(["estimate", "budget", "contract", "change_order", "actual"].map((v) => b("cost_basis", v))).toEqual(["calculated", "selected", "submitted", "submitted", "measured"]);
    expect(["design_basis", "submittal", "field"].map((v) => b("product_layer", v))).toEqual(["selected", "submitted", "installed"]);
    expect(b("cost_basis", "a_newer_basis")).toBe("not recorded");
  });

  it("stored bytes are unchanged by reading", () => {
    const els = [load("LP-1", { anchor: { kind: "space", id: "S1" } }), determination, rule("proposed")];
    const before = JSON.stringify(els);
    for (const el of els) readBasis(el, { infer: true });
    expect(JSON.stringify(els)).toBe(before);
  });

  it("a pack adds a rung and maps its own ladder with no kernel edit", () => {
    const pack = definePack({ id: "zq", name: "Test inspection", version: "1.0.0", kernel: "^1.8.0" }, [
      contribute(BASIS_POINT, [{ id: "zq.witnessed", label: "Witnessed", order: 75, maps: [{ ladder: "zq.inspection", value: "witnessed" }] }]),
    ]);
    const set = PackSet.create([pack]);
    expect(basisTable(set).rows.map((r) => r.id).indexOf("zq.witnessed")).toBe(basisTable(set).rows.map((r) => r.id).indexOf("measured") + 1);
    const r = ladderBasis("zq.inspection", "witnessed", {}, set);
    expect(r.known && r.basis.maturity).toBe("zq.witnessed");
  });
});
