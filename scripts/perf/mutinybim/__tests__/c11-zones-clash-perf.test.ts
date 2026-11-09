/**
 * @jest-environment node
 *
 * Round 11 C11, measured first: derived zones and the clearance clash at
 * 250k, on the code before part positions, and again after (same harness).
 * C11_PERF=1 runs it (it builds the 250k synthetic), through the run lock.
 *
 * Rows (printed, `[c11 <row>] p50 … p95 …`):
 * - zones.derived.all_parts.250k: every placed part's clearance regions under
 *   the service-access rule, each part a fresh record (the per-host cache misses).
 * - zones.derived.all_parts.250k.warm: the same, the cache kept.
 * - lint.clearance.one_edit.250k: one part moved, the coordination index
 *   advanced and the clearance rule run on it.
 */
import { asElementId, derivedZonesOfHost, draftElements, elementsOfKind, executeCommand, freezeElements, partClearances, type ModelState, type PartInstance } from "@permitzip/bim-kernel";
import { ALL_RULES, DEFAULT_LINT_CONFIG, LintEngine } from "@permitzip/bim-lint";
import { createSynthetic250k, p50p95 } from "../synthetic-250k";

const run = process.env.C11_PERF === "1" ? describe : describe.skip;
const FT = 304.8;

function report(row: string, samples: readonly number[], extra = ""): void {
  const s = p50p95(samples);
  process.stderr.write(`[c11 ${row}] p50 ${s.p50} ms, p95 ${s.p95} ms (n=${samples.length})${extra ? `; ${extra}` : ""}\n`);
}

/** Every one of the synthetic's five part types gets a front service zone and a keep-clear zone on top. */
function withClearances(model: ModelState, templateIds: readonly string[]): ModelState {
  let m = model;
  for (const id of templateIds) {
    const r = executeCommand(m, {
      type: "set_part_clearances",
      id,
      scope: "type",
      zones: [
        { id: "service", name: "Service access", purpose: "service_access", face: "front", depth: 3 * FT },
        { id: "above", name: "Keep clear", purpose: "keep_out", face: "top", depth: 2 * FT },
      ],
    });
    if (!r.ok) throw new Error(`[c11-perf] set_part_clearances ${id}: ${r.error.message}`);
    m = r.model;
  }
  return m;
}

run("c11 derived zones and clearance clash (250k)", () => {
  const syn = createSynthetic250k();
  const head = withClearances(syn.model, syn.partIds.slice(0, 5));
  const parts = elementsOfKind(head.elements, "part");

  it("zones.derived.all_parts.250k (cold and warm)", () => {
    const cold: number[] = [];
    const warm: number[] = [];
    let regions = 0;
    for (let s = 0; s < 7; s++) {
      const fresh: PartInstance[] = parts.map((p) => ({ ...p }));
      const draft = draftElements(head.elements);
      for (const p of fresh) draft[p.id] = p;
      const model: ModelState = { ...head, elements: freezeElements(draft) };
      const t0 = performance.now();
      regions = 0;
      for (const p of fresh) regions += derivedZonesOfHost(model, p, "clearance:service_access").length;
      cold.push(performance.now() - t0);
      const t1 = performance.now();
      for (const p of fresh) derivedZonesOfHost(model, p, "clearance:service_access");
      warm.push(performance.now() - t1);
    }
    expect(regions).toBe(parts.length);
    report("zones.derived.all_parts.250k", cold, `${parts.length} parts, ${regions} regions`);
    report("zones.derived.all_parts.250k.warm", warm);
    let placed = 0;
    const t2 = performance.now();
    for (const p of parts) placed += partClearances(head, p).length;
    process.stderr.write(`[c11 part_clearances.all_parts.250k] ${Math.round(performance.now() - t2)} ms for ${placed} zones\n`);
  });

  it("lint.clearance.one_edit.250k", () => {
    const rules = ALL_RULES.filter((r) => r.id === "clearance-intrusion");
    expect(rules).toHaveLength(1);
    const engine = new LintEngine(rules);
    const t0 = performance.now();
    engine.build(head, []);
    const buildMs = performance.now() - t0;
    let m = head;
    const target = asElementId(syn.partIds[1_234] ?? "syn-part-1234");
    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const r = executeCommand(m, { type: "move_elements", ids: [target], delta: { x: i % 2 === 0 ? 300 : -300, y: 0 } });
      if (!r.ok) throw new Error(r.error.message);
      const t1 = performance.now();
      engine.advance(r.model, [...r.changedIds, ...r.removedIds]);
      engine.check({ config: { ...DEFAULT_LINT_CONFIG, ruleset: "issue" }, ids: [target] });
      samples.push(performance.now() - t1);
      m = r.model;
    }
    report("lint.clearance.one_edit.250k", samples, `index build ${Math.round(buildMs)} ms`);
  });
});
