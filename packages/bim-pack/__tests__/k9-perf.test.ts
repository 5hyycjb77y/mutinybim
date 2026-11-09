/**
 * @jest-environment node
 *
 * Round 9 lane K9 perf rows (in-process, `planCommit` timed edit after edit):
 * - `validate.addon_switch.first_edit`: the first ordinary edit after the
 *   test add-on (one pipe run check) is switched on, then off, on the
 *   all-discipline building plus a gas system the check flags;
 * - `validate.first_edit_after_load.open_issues`: the first ordinary edit on
 *   a head loaded fresh (no index, no facts) with an issue open, and how many
 *   whole-model checks it ran (a cold pass, a full ledger build).
 *
 * K9_PERF=1 runs it; K9_PERF_SCALE=250k or 1M picks the building (default XS,
 * so a plain run stays light).
 */
import { buildPointReads, elementsFromRows, incrementalValidationStats, installModelSetupHost, issuesOf, offerValidationState, planCommit, validateModel, validationStateOf, validationStateStats, withUpgradePolicy, type BimElement, type Command, type ElementId, type ModelState, type ValidationIssue } from "@permitzip/bim-kernel";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_MESSAGE_START, CHECK_TEST_PACK } from "./fixtures/check-addon";

const RUN = process.env.K9_PERF === "1";
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";
const SCALE = process.env.K9_PERF_SCALE;
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
  return { ...big, modelId: `k9-perf-${SCALE ?? "xs"}`, elements: { ...big.elements, ...gas.elements }, connections: [...big.connections, ...gas.connections] };
}

let seq = 0;
function timedCommit(head: ModelState, command: Command): { readonly model: ModelState; readonly ms: number } {
  seq += 1;
  const request = { idempotencyKey: `k9-perf-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" as const }, command };
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

/** A part whose type the model doesn't have: an issue open away from anything the edits touch. */
function withOpenIssue(model: ModelState): ModelState {
  const level = Object.values(model.elements).find((e) => e.kind === "level");
  const part = { version: 1, authoredRev: {}, id: "k9-orphan", kind: "part", typeId: "k9-missing-type", levelId: level?.id ?? "lvl-1", position: { x: 0, y: 50_000 }, offsetMm: 0, rotationDeg: 0, mark: "X1", values: {} } as unknown as BimElement;
  return { ...model, elements: { ...model.elements, [part.id]: part } };
}

/** Whole-model checks run so far: W's full ledger builds plus cold passes. */
const wholeChecks = (): number => {
  const s = incrementalValidationStats();
  return s.fullPasses + s.coldPasses;
};

describePerf("k9 add-on switch and first edit after load", () => {
  it("validate.addon_switch.first_edit and validate.first_edit_after_load.open_issues", () => {
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
    const before = run(20);
    // The host builds the point index the cold save skipped once it is idle (round 10), before anyone switches.
    const tIndex = performance.now();
    buildPointReads(head);
    const indexMs = performance.now() - tIndex;

    // ── Switch on, then off ──────────────────────────────────────────────
    const on = timedCommit(head, switchCheck(true));
    head = on.model;
    const c0 = wholeChecks();
    const firstOn = timedCommit(head, ordinary());
    const checksOn = wholeChecks() - c0;
    head = firstOn.model;
    const foundOn = ours(issuesOf(head));
    const withAddon = run(20);
    const off = timedCommit(head, switchCheck(false));
    head = off.model;
    const c1 = wholeChecks();
    const firstOff = timedCommit(head, ordinary());
    const checksOff = wholeChecks() - c1;
    head = firstOff.model;
    const foundOff = ours(issuesOf(head));
    const after = run(20);
    expect(JSON.stringify(issuesOf(head))).toBe(JSON.stringify(withModelStatePacks(head, () => validateModel(head))));

    // ── A head with an issue open, loaded fresh ──────────────────────────
    const broken = withOpenIssue(head);
    const loaded = { ...broken, elements: { ...broken.elements } };
    const c2 = wholeChecks();
    const firstLoaded = timedCommit(loaded, ordinary());
    const checksLoaded = wholeChecks() - c2;
    head = firstLoaded.model;
    const afterLoad = run(20);
    expect(JSON.stringify(issuesOf(head))).toBe(JSON.stringify(withModelStatePacks(head, () => validateModel(head))));

    // ── The same head opened by another process with its kept validation state ──
    // The model server builds the index its saves skipped before writing the state (pg-store `writeValidationState`).
    buildPointReads(head);
    const tw0 = performance.now();
    const state = validationStateOf(head, "k9-perf-build");
    if (!state) throw new Error("no validation state for the head");
    const stored = JSON.stringify(state);
    const tw1 = performance.now();
    const readBack: unknown = JSON.parse(stored);
    const tw2 = performance.now();
    const rssBefore = process.memoryUsage().rss;
    // Round 10 S10: reopened the way the model server reads a head (pg-store: fresh rows through elementsFromRows), not as a
    // plain-object spread no host ever opens; the spread made this edit index a 1M-key plain record first (595 ms at 1M).
    const reopened: ModelState = {
      ...head,
      elements: elementsFromRows(JSON.parse(JSON.stringify(Object.values(head.elements))) as BimElement[]),
      connections: JSON.parse(JSON.stringify(head.connections)) as ModelState["connections"],
    };
    offerValidationState(reopened, readBack, "k9-perf-build");
    // A server process holds one copy of the head; this one holds several, so collect before timing when the run exposes gc.
    (globalThis as { gc?: () => void }).gc?.();
    const c3 = wholeChecks();
    const a3 = validationStateStats().adopted;
    const firstAdopted = timedCommit(reopened, ordinary());
    const checksAdopted = wholeChecks() - c3;
    const adopted = validationStateStats().adopted - a3;
    const rssAfter = process.memoryUsage().rss;
    head = firstAdopted.model;
    expect(JSON.stringify(issuesOf(head))).toBe(JSON.stringify(withModelStatePacks(head, () => validateModel(head))));

    const elements = Object.keys(head.elements).length;
    process.stderr.write(
      `[k9 perf kept state] written ${(tw1 - tw0).toFixed(0)} ms (${(stored.length / 1e6).toFixed(2)} MB, ${state.reads.exceptionIds.length} elements off their kind's signature, ${state.reads.signatures.length} signatures, ${state.issues.length} issues), read back ${(tw2 - tw1).toFixed(0)} ms; ` +
        `opened with it: first edit ${firstAdopted.ms.toFixed(0)} ms (${checksAdopted} whole-model checks, adopted ${adopted}); rss ${(rssBefore / 1e6).toFixed(0)} → ${(rssAfter / 1e6).toFixed(0)} MB around the reopen (includes the reopened copy)\n`,
    );
    expect(adopted).toBe(1);
    expect(checksAdopted).toBe(0);
    if (ABSOLUTE_BUDGETS) expect(firstAdopted.ms).toBeLessThan(500);
    process.stderr.write(
      `[k9 perf] ${elements} elements: cold commit ${cold.ms.toFixed(0)} ms (point index after it ${indexMs.toFixed(0)} ms); before p50 ${pct(before, 0.5).toFixed(2)} / p95 ${pct(before, 0.95).toFixed(2)} ms; ` +
        `switch on ${on.ms.toFixed(1)} ms, first edit after ${firstOn.ms.toFixed(1)} ms (${checksOn} whole-model checks, ${foundOn} add-on issues); ` +
        `with add-on p50 ${pct(withAddon, 0.5).toFixed(2)} / p95 ${pct(withAddon, 0.95).toFixed(2)} ms; ` +
        `switch off ${off.ms.toFixed(1)} ms, first edit after ${firstOff.ms.toFixed(1)} ms (${checksOff} whole-model checks, ${foundOff} add-on issues); ` +
        `after p50 ${pct(after, 0.5).toFixed(2)} / p95 ${pct(after, 0.95).toFixed(2)} ms; ` +
        `loaded with an issue open: first edit ${firstLoaded.ms.toFixed(0)} ms (${checksLoaded} whole-model checks), then p50 ${pct(afterLoad, 0.5).toFixed(2)} / p95 ${pct(afterLoad, 0.95).toFixed(2)} ms\n`,
    );
    expect(foundOn).toBeGreaterThan(0);
    expect(foundOff).toBe(0);
    // A switch re-checks what the add-on's rows reach: no whole-model check.
    expect(checksOn).toBe(0);
    expect(checksOff).toBe(0);
    // A head loaded with an issue open: one whole-model check, not two.
    expect(checksLoaded).toBe(1);
    // The rows (README "Performance rows"): 500 ms p50 at 250k and at 1M.
    if (ABSOLUTE_BUDGETS) {
      expect(firstOn.ms).toBeLessThan(500);
      expect(firstOff.ms).toBeLessThan(500);
    }
  });
});
