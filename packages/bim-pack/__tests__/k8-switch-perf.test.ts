/**
 * @jest-environment node
 *
 * Round 8b lane K perf row `validate.addon_switch.first_edit` (in-process):
 * the first edit after an add-on is switched on or off, on the all-discipline
 * building plus a gas piping system the test add-on's check flags. Beside it,
 * the commit p50 / p95 of ordinary edits before and after the switch (the
 * round 8 close-out asked for the commit numbers on this building).
 *
 * K8_PERF=1 runs it; K8_PERF_SCALE=250k or 1M picks the building (default XS,
 * so a plain run stays light). Timed: `planCommit` (execute, derive, validate,
 * stamp) on the in-memory head, edit after edit.
 */
import { installModelSetupHost, issuesOf, planCommit, validateModel, withUpgradePolicy, type Command, type ElementId, type ModelState, type ValidationIssue } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_MESSAGE_START, CHECK_TEST_PACK } from "./fixtures/check-addon";

const RUN = process.env.K8_PERF === "1";
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";
const SCALE = process.env.K8_PERF_SCALE;
const NOW = () => "2026-11-01T00:00:00.000Z";
const describePerf = RUN ? describe : describe.skip;

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [CHECK_TEST_PACK]);
});
afterAll(() => uninstall());

function building(): ModelState {
  const tier = SCALE === "1M" ? FULL_BIM_TIERS["1M"] : SCALE === "250k" ? FULL_BIM_TIERS["250k"] : FULL_BIM_TIERS.XS;
  const big = createFullBimModel(tier);
  const gas = buildSampleMarketGas();
  return { ...big, modelId: `k8-perf-${SCALE ?? "xs"}`, elements: { ...big.elements, ...gas.elements }, connections: [...big.connections, ...gas.connections] };
}

let seq = 0;
function timedCommit(head: ModelState, command: Command): { readonly model: ModelState; readonly ms: number } {
  seq += 1;
  const request = { idempotencyKey: `k8-perf-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" as const }, command };
  const t0 = performance.now();
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], request, NOW));
  const ms = performance.now() - t0;
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return { model: d.model, ms };
}

function idsOf(model: ModelState, kind: string): ElementId[] {
  return Object.values(model.elements)
    .filter((e) => e.kind === kind)
    .map((e) => e.id);
}

function pct(list: readonly number[], p: number): number {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}

const ours = (issues: readonly ValidationIssue[]): number => issues.filter((i) => i.message.startsWith(CHECK_MESSAGE_START)).length;
const switchCheck = (on: boolean): Command => ({ type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on });

describePerf("k8 validate.addon_switch.first_edit perf", () => {
  it("the first edit after a switch re-checks once; ordinary commits are unchanged", () => {
    let head = building();
    const walls = idsOf(head, "wall");
    const tags = idsOf(head, "tag");
    const terminals = idsOf(head, "terminal");
    const equipment = idsOf(head, "equipment");
    const taps = idsOf(head, "tap");
    let i = 0;
    const ordinary = (): Command => {
      i += 1;
      switch (i % 5) {
        case 0:
          return { type: "move_wall", wallId: walls[(i * 7919) % walls.length] ?? "", delta: { x: 10, y: 0 } };
        case 1:
          return { type: "move_tag", tagId: tags[(i * 104729) % tags.length] ?? "", offset: { x: 40, y: 40 } };
        case 2:
          return { type: "set_terminal_cfm", terminalId: terminals[(i * 31) % terminals.length] ?? "", cfm: 200 + i };
        case 3:
          return { type: "move_equipment", equipmentId: equipment[(i * 13) % equipment.length] ?? "", delta: { x: 5, y: 0 } };
        default: {
          const tapId = taps[(i * 101) % taps.length] ?? "";
          const tap = head.elements[tapId];
          return { type: "slide_branch", tapId, s: (tap?.kind === "tap" ? tap.s : 0) + (i % 2 === 0 ? 25 : -25) };
        }
      }
    };
    const run = (n: number): number[] => {
      const out: number[] = [];
      for (let k = 0; k < n; k++) {
        const r = timedCommit(head, ordinary());
        out.push(r.ms);
        head = r.model;
      }
      return out;
    };

    const cold = timedCommit(head, ordinary());
    head = cold.model;
    const before = run(40);

    const on = timedCommit(head, switchCheck(true));
    head = on.model;
    const firstOn = timedCommit(head, ordinary());
    head = firstOn.model;
    const foundOn = ours(issuesOf(head));
    // Like for like: a cold commit on the same state loaded fresh (no index, no facts), add-on on, its issues open.
    const reloaded = timedCommit({ ...head, elements: { ...head.elements } }, ordinary());
    const withAddon = run(40);

    const off = timedCommit(head, switchCheck(false));
    head = off.model;
    const firstOff = timedCommit(head, ordinary());
    head = firstOff.model;
    const foundOff = ours(issuesOf(head));
    const after = run(20);

    const elements = Object.keys(head.elements).length;
    process.stderr.write(
      `[k8 addon_switch] ${elements} elements: cold commit ${cold.ms.toFixed(0)} ms; ` +
        `before switch p50 ${pct(before, 0.5).toFixed(2)} / p95 ${pct(before, 0.95).toFixed(2)} ms; ` +
        `switch on ${on.ms.toFixed(1)} ms, first edit after ${firstOn.ms.toFixed(1)} ms (cold commit of that state loaded fresh ${reloaded.ms.toFixed(0)} ms); ` +
        `with add-on p50 ${pct(withAddon, 0.5).toFixed(2)} / p95 ${pct(withAddon, 0.95).toFixed(2)} ms; ` +
        `switch off ${off.ms.toFixed(1)} ms, first edit after ${firstOff.ms.toFixed(1)} ms; ` +
        `after p50 ${pct(after, 0.5).toFixed(2)} / p95 ${pct(after, 0.95).toFixed(2)} ms; ` +
        `add-on issues open after the first edit: on ${foundOn}, off ${foundOff}\n`,
    );
    expect(foundOn).toBeGreaterThan(0);
    expect(foundOff).toBe(0);
    // The last head's issues are full validation's under its own set.
    expect(JSON.stringify(issuesOf(head))).toBe(JSON.stringify(withModelStatePacks(head, () => validateModel(head))));
    // Never worse than loading the same state cold.
    expect(firstOn.ms).toBeLessThan(reloaded.ms);
    if (SCALE !== "1M" && ABSOLUTE_BUDGETS) {
      // The row at 250k: no more than a cold commit (commit.cold p50 500 ms). The 1M target (500 ms) is open: k-recheck.md.
      expect(firstOn.ms).toBeLessThan(500);
      expect(firstOff.ms).toBeLessThan(500);
    }
  });
});
