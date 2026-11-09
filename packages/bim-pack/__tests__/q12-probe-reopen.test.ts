/**
 * @jest-environment node
 */
import { buildPointReads, elementsFromRows, incrementalValidationStats, installModelSetupHost, issuesOf, offerValidationState, planCommit, validationStateOf, validationStateStats, withUpgradePolicy, type BimElement, type Command, type ModelState } from "@permitzip/bim-kernel";
import { createFullBimModel } from "@permitzip/bim-first-party/seed";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_TEST_PACK } from "./fixtures/check-addon";
import { establishedFacts } from "../../bim-kernel/src/network";
import { issueUnitsOf } from "../../bim-kernel/src/validate";
import { exportPointReads, hasUsablePointReads } from "../../bim-kernel/src/validate-ledger";

const NOW = () => "2026-11-01T00:00:00.000Z";
let seq = 0;
let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [CHECK_TEST_PACK]);
});
afterAll(() => uninstall());

function commit(head: ModelState, command: Command): { model: ModelState; ms: number } {
  seq += 1;
  const t0 = performance.now();
  const d = withUpgradePolicy(() => true, () => planCommit(head, [], { idempotencyKey: `q12p-${seq}`, baseRevision: head.revision, actor: { id: "k", name: "K", kind: "human" }, command }, NOW));
  const ms = performance.now() - t0;
  if (!d.ok) throw new Error(d.error.message);
  return { model: d.model, ms };
}
const stats = () => ({ ...incrementalValidationStats(), ...validationStateStats() });
const reopen = (head: ModelState): ModelState => ({ ...head, elements: elementsFromRows(JSON.parse(JSON.stringify(Object.values(head.elements))) as BimElement[]), connections: JSON.parse(JSON.stringify(head.connections)) as ModelState["connections"] });

it("probe", () => {
  const big = createFullBimModel({ floors: 1, zonesPerFloor: 2 });
  const gas = buildSampleMarketGas();
  let head: ModelState = { ...big, modelId: "q12-probe", elements: { ...big.elements, ...gas.elements }, connections: [...big.connections, ...gas.connections] };
  const walls = Object.values(head.elements).filter((e) => e.kind === "wall").map((e) => e.id);
  let i = 0;
  const ordinary = (): Command => ({ type: "move_wall", wallId: walls[(++i * 7919) % walls.length] ?? "", delta: { x: 10, y: 0 } });
  head = commit(head, ordinary()).model;
  for (let k = 0; k < 3; k++) head = commit(head, ordinary()).model;
  const lines: string[] = [`elements ${Object.keys(head.elements).length}`];
  const trial = (label: string, h: ModelState) => {
    buildPointReads(h);
    const state = validationStateOf(h, "b");
    if (!state) {
      const known = establishedFacts(h);
      lines.push(`${label}: no state (facts ${known ? "yes" : "no"}, units ${known ? (issueUnitsOf(h, known.issues) ? "yes" : "no") : "-"}, reads ${exportPointReads(h) ? "yes" : "no"}, usable ${hasUsablePointReads(h)})`);
      return;
    }
    const body = JSON.stringify(state);
    const fresh = reopen(h);
    offerValidationState(fresh, JSON.parse(body), "b");
    const s0 = stats();
    const ta = performance.now();
    issuesOf(fresh);
    const adoptMs = performance.now() - ta;
    const s1 = stats();
    const r = commit(fresh, ordinary());
    const s2 = stats();
    lines.push(
      `${label}: state ${(body.length / 1e3).toFixed(0)} kB, exceptions ${state.reads.exceptionIds.length}, sigs ${state.reads.signatures.length}, issues ${state.issues.length}; ` +
        `adopt ${adoptMs.toFixed(1)} ms (adopted ${s1.adopted - s0.adopted}, declined ${s1.declined - s0.declined} ${s1.lastDeclined}, units ${s1.unitsRerun - s0.unitsRerun}, whole ${s1.fullPasses + s1.coldPasses - s0.fullPasses - s0.coldPasses}); ` +
        `first edit ${r.ms.toFixed(1)} ms (units ${s2.unitsRerun - s1.unitsRerun}, whole ${s2.fullPasses + s2.coldPasses - s1.fullPasses - s1.coldPasses})`,
    );
  };
  trial("no switch", head);
  head = commit(head, { type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on: true }).model;
  trial("after on (no edit)", head);
  head = commit(head, ordinary()).model;
  trial("after on + 1 edit", head);
  head = commit(head, { type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on: false }).model;
  trial("after off", head);
  process.stderr.write(`[q12 probe]\n${lines.join("\n")}\n`);
});
