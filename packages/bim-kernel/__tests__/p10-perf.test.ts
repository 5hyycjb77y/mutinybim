/**
 * @jest-environment node
 *
 * Round 10 lane P10 performance rows (README "Performance rows"), the same
 * workload as `scripts/perf/mutinybim/pipe-products.ts`: the tier's
 * full-building model, a synthetic copper cold water system and a stored
 * elbow on every piece.
 *
 * - pipes.lift.stored: every pipe fitting's joint as its end type and every
 *   piece's product, on a fresh pack set (tables built inside the timing).
 *   Budget 40 / 80 ms at 250k, 160 / 320 at 1M.
 * - pipes.joint_issue.edit_50 and pipes.sizing.edit_50: what one edit's 50
 *   fittings and pieces cost. Budget 0.1 / 0.2 ms.
 *
 * P10_PERF=1 runs it; P10_PERF_TIER picks the tier (250k by default; 1M only
 * through the laptop-wide heavy lock). Fails on round 9's code: there is no
 * `liftPipeJoints` and no product table to build.
 */
import { asElementId, elementValues, elementsOfKind, fittingFamily, freezeElements, jointIssue, liftPipeJoints, pipeDims, pipeParams, pipeSizeIssue, resolveParams, specOfSize, syntheticPlumbing, type BimElement, type Level, type ModelState, type RunFitting } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { PackSet, installedFirstPartyPacks, withPackSet } from "@permitzip/bim-kernel/packs";

type Tier = keyof typeof FULL_BIM_TIERS;
const isTier = (value: string): value is Tier => value in FULL_BIM_TIERS;
const RUN = process.env.P10_PERF === "1";
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";
const TIER = process.env.P10_PERF_TIER ?? "250k";
const BUDGET = { lift: TIER === "1M" ? { p50: 160, p95: 320 } : { p50: 40, p95: 80 }, edit: { p50: 0.1, p95: 0.2 } };

function p50p95(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { p50: at(0.5), p95: at(0.95) };
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

function model(tier: Tier): ModelState {
  const base = createFullBimModel(FULL_BIM_TIERS[tier]);
  const existing = elementValues(base.elements).find((e) => e.kind === "level");
  const level: Level = existing?.kind === "level" ? existing : { id: asElementId("synp-level"), kind: "level", version: 1, authoredRev: {}, name: "Level 1", elevationMm: 0 };
  const syn = syntheticPlumbing({ levelId: level.id, trunks: tier === "1M" ? 200 : 50, branchesPerTrunk: 100 });
  const elbow = fittingFamily("pipe.water.elbow_90");
  if (!elbow) throw new Error("pipe.water.elbow_90");
  const elbows: Record<string, BimElement> = {};
  for (const el of Object.values(syn.elements)) {
    if (el.kind !== "run_segment" || el.size.shape !== "pipe") continue;
    const id = asElementId(`${el.id}-elbow`);
    const ports = [{ id: "a", position: el.end, direction: { x: -1, y: 0, z: 0 }, size: el.size }, { id: "b", position: el.end, direction: { x: 0, y: 1, z: 0 }, size: el.size }];
    elbows[id] = { id, kind: "run_fitting", version: 0, authoredRev: {}, fittingType: "elbow", label: elbow.name, domain: "pipe", systemId: el.systemId, levelId: el.levelId, position: el.end, angleDeg: 90, ports, family: elbow.id, params: resolveParams(elbow, pipeParams(elbow, el.size, undefined)) } satisfies RunFitting;
  }
  return { ...base, elements: freezeElements({ ...base.elements, [level.id]: level, ...syn.elements, ...elbows }) };
}

(RUN ? describe : describe.skip)(`p10-perf (${TIER})`, () => {
  it("meets the pipe rows", () => {
    if (!isTier(TIER)) throw new Error(`P10_PERF_TIER must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
    const m = model(TIER);
    const fittings = elementsOfKind(m.elements, "run_fitting").filter((f) => f.domain === "pipe" && f.family !== undefined);
    const pieces = elementsOfKind(m.elements, "run_segment").filter((s) => s.size.shape === "pipe");
    let lifted = -1;
    const lift = time(21, () => {
      const fresh = PackSet.create(installedFirstPartyPacks());
      lifted = withPackSet(fresh, () => {
        let n = 0;
        for (const e of liftPipeJoints(fittings).values()) if (e !== undefined) n += 1;
        for (const s of pieces) if (s.size.shape === "pipe" && specOfSize(s.size)) n += 1;
        return n;
      });
    });
    expect(lifted).toBe(fittings.length + pieces.length);
    let issues = 0;
    const joint = time(21, (i) => {
      const from = (i * 977) % (fittings.length - 50);
      for (const f of fittings.slice(from, from + 50)) {
        const family = f.family ? fittingFamily(f.family) : null;
        if (family && jointIssue(family, f.params ?? {}, f.ports[0]?.size)) issues += 1;
      }
    });
    expect(issues).toBe(0);
    const sizing = time(21, (i) => {
      const from = (i * 977) % (pieces.length - 50);
      for (const s of pieces.slice(from, from + 50)) if (s.size.shape === "pipe") void (pipeDims(s.size).idMm + (specOfSize(s.size)?.roughnessMm ?? 0) + (pipeSizeIssue(s.size) === null ? 0 : 1));
    });
    const rows = { "pipes.lift.stored": p50p95(lift), "pipes.joint_issue.edit_50": p50p95(joint), "pipes.sizing.edit_50": p50p95(sizing) };
    process.stderr.write(`[p10 ${TIER}] ${JSON.stringify(rows)} (${Object.keys(m.elements).length} elements, ${fittings.length} fittings, ${pieces.length} pieces)\n`);
    if (ABSOLUTE_BUDGETS) {
      expect(rows["pipes.lift.stored"].p50).toBeLessThanOrEqual(BUDGET.lift.p50);
      expect(rows["pipes.lift.stored"].p95).toBeLessThanOrEqual(BUDGET.lift.p95);
      for (const row of [rows["pipes.joint_issue.edit_50"], rows["pipes.sizing.edit_50"]]) {
        expect(row.p50).toBeLessThanOrEqual(BUDGET.edit.p50);
        expect(row.p95).toBeLessThanOrEqual(BUDGET.edit.p95);
      }
    }
  });
});
