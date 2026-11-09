/**
 * @jest-environment node
 *
 * Round 8 lane T: the network solve and tap checks at 250k, measured before
 * and after tap hosting and tree totals moved into the Mechanical add-on
 * (an internal design note records both runs). Each case
 * prints `[t8 <row>] p50 … p95 …`. The expectations are coarse ceilings so a
 * loaded laptop doesn't fail them; the budgets are the gate's.
 *
 * T8_PERF=1 runs it (it builds a 250k model). Run through the round's lock.
 */
import { draftElements, elementsOfKind, executeCommand, freezeElements, isFullyDerived, recomputeDerived, recomputeDerivedAfter, validateModel, type BimElement, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { networkOf } from "../src/network";
import { airflowOf, carriesAir } from "@permitzip/bim-pack-mechanical";
/** Samples' p50 and p95 by nearest rank. */
function p50p95(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { p50: Math.round(at(0.5) * 100) / 100, p95: Math.round(at(0.95) * 100) / 100 };
}

const run = process.env.T8_PERF === "1" ? describe : describe.skip;

function report(row: string, samples: readonly number[], extra = ""): void {
  const s = p50p95(samples);
  process.stderr.write(`[t8 ${row}] p50 ${s.p50} ms, p95 ${s.p95} ms (n=${samples.length})${extra ? `; ${extra}` : ""}\n`);
}

function time(n: number, fn: (i: number) => void): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t0 = performance.now();
    fn(i);
    if (i > 0) out.push(performance.now() - t0);
  }
  return out;
}

run("t8 tap hosting and tree totals at 250k", () => {
  const built = createFullBimModel({ ...FULL_BIM_TIERS["250k"], modelId: "t8-250k" });
  // A committed head (frozen record), as the model server holds it.
  const head: ModelState = { ...built, elements: freezeElements(built.elements) };
  // Air terminals: a pipe, sprinkler or power leaf on these kinds adds nothing to the air total (round 9, a9-pipe-not-in-air-total).
  const terminals = elementsOfKind(head.elements, "terminal").filter(carriesAir);
  const taps = elementsOfKind(head.elements, "tap");
  const count = Object.keys(head.elements).length;

  it("network.index.build.250k: a fresh revision's topology index, built in full", () => {
    const s = time(5, () => {
      networkOf({ ...head, elements: draftElements(head.elements) });
    });
    report("network.index.build.250k", s, `${count} elements, ${taps.length} taps, ${terminals.length} terminals`);
  });

  it("derived.full.250k: every derived value recomputed (taps placed, totals summed)", () => {
    networkOf(head);
    const s = time(5, () => {
      expect(recomputeDerived(head).changedIds.length).toBe(0);
    });
    report("derived.full.250k", s);
  });

  it("derived.check.250k: the cold 'fully derived' check by slot", () => {
    const s = time(5, () => {
      expect(isFullyDerived(head)).toBe(true);
    });
    report("derived.check.250k", s);
  });

  it("derived.terminal_edit.250k: one terminal's value changed, totals re-summed along its path", () => {
    const s = time(9, (i) => {
      const t = terminals[(i * 977) % terminals.length];
      if (!t) return;
      const w: Record<string, BimElement> = draftElements(head.elements);
      w[t.id] = { ...t, cfm: (airflowOf(t) ?? 0) + 10 };
      expect(recomputeDerivedAfter(head, w, [t.id]).changedIds.length).toBeGreaterThan(0);
    });
    report("derived.terminal_edit.250k", s);
  });

  it("derived.topology_edit.250k: one terminal removed, derived values after it", () => {
    const s = time(9, (i) => {
      const t = terminals[(i * 977) % terminals.length];
      if (!t) return;
      const w = draftElements(head.elements);
      delete w[t.id];
      expect(recomputeDerivedAfter(head, w, [t.id]).changedIds.length).toBeGreaterThan(0);
    });
    report("derived.topology_edit.250k", s);
  });

  it("derived.retap.250k: one tap slid along its host, re-placed", () => {
    const s = time(9, (i) => {
      const tap = taps[(i * 389) % taps.length];
      if (!tap) return;
      const w: Record<string, BimElement> = draftElements(head.elements);
      w[tap.id] = { ...tap, s: tap.s + 1 };
      expect(recomputeDerivedAfter(head, w, [tap.id]).changedIds).toContain(tap.id);
    });
    report("derived.retap.250k", s);
  });

  it("validate.cold.250k: full validation (tap host, clearance and spacing checks) on a fresh record", () => {
    const s = time(3, () => {
      const fresh: ModelState = { ...head, elements: draftElements(head.elements) };
      validateModel(fresh);
    });
    report("validate.cold.250k", s);
  });

  it("commit.slide_branch.250k and commit.set_terminal_value.250k: two edits through executeCommand on the head", () => {
    const slide = time(9, (i) => {
      const tap = taps[(i * 389) % taps.length];
      if (!tap) return;
      const r = executeCommand(head, { type: "slide_branch", tapId: tap.id, s: tap.s + 5 });
      expect(r.ok).toBe(true);
    });
    report("commit.slide_branch.250k", slide);
    const value = time(9, (i) => {
      const t = terminals[(i * 977) % terminals.length];
      if (!t) return;
      const r = executeCommand(head, { type: "set_terminal_cfm", terminalId: t.id, cfm: (airflowOf(t) ?? 0) + 10 });
      expect(r.ok).toBe(true);
    });
    report("commit.set_terminal_value.250k", value);
  });
});
