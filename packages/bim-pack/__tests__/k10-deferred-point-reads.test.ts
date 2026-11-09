/**
 * @jest-environment node
 *
 * Round 10: the first save on a freshly loaded head no longer records which
 * add-on contributions each check reads. The point index is built after it
 * (`buildPointReads`, called by the host when idle), and until it is an
 * add-on switch re-checks the whole model, so nothing is missed:
 * - the first save leaves the index unbuilt;
 * - a switch before it is built finds exactly what it finds with the index
 *   (and what a full validation finds), edits in between included;
 * - the index built after the save, whole or a slice at a time, is the one a
 *   recorded pass gives, check by check;
 * - with it, switching an add-on that owns a kind re-checks every record of
 *   that kind and finds what a full validation finds.
 *
 * Fails on round 9: the first save recorded every check (the index existed
 * before the save was answered).
 */
import {
  buildPointReads,
  ELEMENT_KIND_POINT,
  incrementalValidationStats,
  installModelSetupHost,
  issuesAfterEdit,
  issuesOf,
  kindValue,
  planCommit,
  pointReadsBuildStats,
  pointReadsPending,
  validateModel,
  validationStateOf,
  withUpgradePolicy,
  type BimElement,
  type Command,
  type ElementKindItem,
  type ModelState,
  type ValidationIssue,
} from "@permitzip/bim-kernel";
import { contribute, definePack, PACK_CONTRACT_VERSION, withModelStatePacks } from "@permitzip/bim-kernel/packs";
import { exportPointReads, type PointReadsExport } from "../../bim-kernel/src/validate-ledger";
import { buildSampleMarketGas } from "../../bim-kernel/__tests__/fixtures/sample-market-gas";
import { CHECK_ADDON_ID, CHECK_ADDON_VERSION, CHECK_MESSAGE_START, CHECK_TEST_PACK } from "./fixtures/check-addon";

const NOW = () => "2026-11-01T00:00:00.000Z";
let seq = 0;

/** A test add-on that owns a kind (an element-kind row) with its own check: switching it changes what every record of the kind is checked against. */
const KIND_ADDON_ID = "k10vt";
const KIND_ADDON_VERSION = "1.0.0";
const CAR_KIND = "k10vt.car";
const CAR_MESSAGE_START = "K10 car:";
const CAR_ROW: ElementKindItem = {
  kind: CAR_KIND,
  label: "Elevator car",
  values: [{ key: "k10vt.rated_load", label: "Rated load", unit: "lb", authored: true, min: 0, max: 20000 }],
  check(el, _settings, issues) {
    const load = kindValue(el, "k10vt.rated_load");
    if (load !== null && load < 1000) issues.push({ code: "invalid_value", message: `${CAR_MESSAGE_START} ${el.id} is rated below 1000 lb`, elementIds: [el.id] });
  },
};
const KIND_TEST_PACK = definePack({ id: KIND_ADDON_ID, name: "Vertical transport (k10 test)", version: KIND_ADDON_VERSION, kernel: `^${PACK_CONTRACT_VERSION}` }, [contribute(ELEMENT_KIND_POINT, [CAR_ROW])]);

let uninstall: () => void = () => undefined;
beforeAll(() => {
  uninstall = installModelSetupHost(() => [CHECK_TEST_PACK, KIND_TEST_PACK]);
});
afterAll(() => uninstall());

function commit(head: ModelState, command: Command): ModelState {
  seq += 1;
  const d = withUpgradePolicy(
    () => true,
    () => planCommit(head, [], { idempotencyKey: `k10-${seq}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, NOW),
  );
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  return d.model;
}

const switchCheck = (on: boolean): Command => ({ type: "set_model_addon", packId: CHECK_ADDON_ID, version: CHECK_ADDON_VERSION, on });
const switchKind = (on: boolean): Command => ({ type: "set_model_addon", packId: KIND_ADDON_ID, version: KIND_ADDON_VERSION, on });
const cars = (issues: readonly ValidationIssue[]): number => issues.filter((i) => i.message.startsWith(CAR_MESSAGE_START)).length;
const newLevel = (n: number): Command => ({ type: "create_level", levelId: `lvl-k10-${n}`, name: `K10 ${n}`, elevationMm: 20_000 + n * 3_000 });
const fullOf = (m: ModelState): readonly ValidationIssue[] => withModelStatePacks(m, () => validateModel(m));
const text = (issues: readonly ValidationIssue[]): string => JSON.stringify(issues.map((i) => ({ code: i.code, message: i.message, elementIds: [...i.elementIds] })));
const ours = (issues: readonly ValidationIssue[]): number => issues.filter((i) => i.message.startsWith(CHECK_MESSAGE_START)).length;
const opened = (m: ModelState): ModelState => ({ ...m, elements: { ...m.elements } });
const wholeChecks = (): number => {
  const s = incrementalValidationStats();
  return s.fullPasses + s.coldPasses;
};

function withOpenIssue(m: ModelState): ModelState {
  const part = { version: 1, authoredRev: {}, id: "k10-orphan", kind: "part", typeId: "k10-missing-type", levelId: "lvl-1", position: { x: 0, y: 50_000 }, offsetMm: 0, rotationDeg: 0, mark: "X1", values: {} } as unknown as BimElement;
  return { ...m, elements: { ...m.elements, [part.id]: part } };
}

/** Sample Market plus 200 levels (enough checks that a slice ends mid-phase), with an issue open, as a head loaded from storage (nothing known about it). */
function loaded(modelId: string, carCount = 0): ModelState {
  let m: ModelState = { ...buildSampleMarketGas(), modelId };
  for (let n = 100; n < 300; n++) m = commit(m, newLevel(n));
  return opened(withCars(withOpenIssue(m), carCount));
}

/** `count` stored records of the kind add-on's car, each under its minimum: what a peer keeps while that add-on is off. */
function withCars(m: ModelState, count: number): ModelState {
  if (count === 0) return m;
  const elements: Record<string, BimElement> = { ...m.elements };
  for (let n = 0; n < count; n++) {
    const raw: Record<string, unknown> = { id: `k10-car-${n}`, version: 1, authoredRev: {}, kind: CAR_KIND, values: { "k10vt.rated_load": 500 } };
    elements[`k10-car-${n}`] = raw as unknown as BimElement;
  }
  return { ...m, elements };
}

/** A point index as what each check reads, by element id (signature numbers and key order are the builder's own). */
function readsOf(exported: PointReadsExport | null, model: ModelState): Record<string, string[]> {
  if (!exported) throw new Error("no point index");
  const keyName = (n: number): string => `${exported.keys[n]?.kind}:${exported.keys[n]?.id}`;
  const sigReads = (sig: number): string[] => (sig === 0 ? [] : sig === 1 ? ["*"] : sig === 0xffff ? ["unrecorded"] : (exported.signatures[sig - 2] ?? []).map(keyName).sort());
  const exceptions = new Map(exported.exceptionIds.map((id, n) => [id, exported.exceptionSigs[n] ?? 0xffff]));
  const out: Record<string, string[]> = {
    "(connections)": sigReads(exported.connectionSig),
    "(groups)": sigReads(exported.groupSig),
    "(whole)": sigReads(exported.wholeSig),
  };
  for (const el of Object.values(model.elements)) out[el.id] = sigReads(exceptions.get(el.id) ?? exported.byKind[el.kind] ?? 0xffff);
  return out;
}

describe("k10-deferred-point-reads", () => {
  it("the first save on a loaded head records nothing: its point index waits for the host", () => {
    const head0 = loaded("k10-first-save");
    const head = commit(head0, newLevel(1));
    expect(text(issuesOf(head))).toBe(text(fullOf(head)));
    expect(pointReadsPending(head)).toBe(true);
    expect(exportPointReads(head)).toBeNull();
    // Nothing to write as a kept state until it is built (the model server builds it first).
    expect(validationStateOf(head, "k10-build")).toBeNull();
    const built = pointReadsBuildStats().built;
    expect(buildPointReads(head)).toBe(true);
    expect(pointReadsBuildStats().built - built).toBe(1);
    expect(pointReadsPending(head)).toBe(false);
    expect(validationStateOf(head, "k10-build")).not.toBeNull();
  });

  it("a switch before the index is built finds what it finds with it, edits in between included", () => {
    for (const on of [true, false]) {
      let withIndex = loaded(`k10-window-${on}`);
      if (!on) withIndex = commit(withIndex, switchCheck(true));
      let without = opened(withIndex);
      issuesOf(withIndex);
      issuesOf(without);
      buildPointReads(withIndex);
      expect(pointReadsPending(without)).toBe(true);
      for (let n = 0; n < 3; n++) {
        withIndex = commit(withIndex, newLevel(10 + n));
        without = commit(without, newLevel(10 + n));
      }
      // Still not built on the copy: the edits carried the wish along, not an index.
      expect(pointReadsPending(without)).toBe(true);
      const c0 = wholeChecks();
      withIndex = commit(withIndex, switchCheck(on));
      const viaIndex = issuesOf(withIndex);
      const c1 = wholeChecks();
      without = commit(without, switchCheck(on));
      const viaRecheck = issuesOf(without);
      const c2 = wholeChecks();
      expect(text(viaRecheck)).toBe(text(viaIndex));
      expect(text(viaRecheck)).toBe(text(fullOf(without)));
      expect(ours(viaRecheck) > 0).toBe(on);
      // The index re-ran only what the add-on reaches; without it the switch re-checked the whole model.
      expect(c1 - c0).toBe(0);
      expect(c2 - c1).toBeGreaterThan(0);
    }
  });

  it("the index built after the save is the one a recorded pass gives, whole or a slice at a time", () => {
    const base = commit(loaded("k10-equal"), switchCheck(true));
    const deferred = opened(base);
    const sliced = opened(base);
    const recorded = opened(base);
    issuesOf(deferred);
    issuesOf(sliced);
    expect(buildPointReads(deferred)).toBe(true);
    let slices = 1;
    while (!buildPointReads(sliced, 0)) slices += 1;
    expect(slices).toBeGreaterThan(2);
    // The recorded pass: a full ledger records every check as it runs (what a cold pass recorded before round 10).
    issuesAfterEdit(recorded, recorded, []);
    const reference = readsOf(exportPointReads(recorded), recorded);
    expect(Object.values(reference).some((reads) => reads.length > 0)).toBe(true);
    expect(readsOf(exportPointReads(deferred), deferred)).toEqual(reference);
    expect(readsOf(exportPointReads(sliced), sliced)).toEqual(reference);
  });

  it("a switch of an add-on that owns a kind re-checks every record of it through the index built after the save", () => {
    const CARS = 250;
    for (const sliced of [false, true]) {
      let head = loaded(`k10-kind-${sliced}`, CARS);
      issuesOf(head);
      if (sliced) while (!buildPointReads(head, 0));
      else expect(buildPointReads(head)).toBe(true);
      expect(pointReadsPending(head)).toBe(false);
      expect(cars(issuesOf(head))).toBe(0);
      for (const on of [true, false]) {
        const c0 = wholeChecks();
        head = commit(head, switchKind(on));
        const issues = issuesOf(head);
        // Every car is checked against the row the switch brought in (or took away), as full validation finds.
        expect(text(issues)).toBe(text(fullOf(head)));
        expect(cars(issues)).toBe(on ? CARS : 0);
        // Through the index: the cars' checks re-ran, not the whole model.
        expect(wholeChecks() - c0).toBe(0);
      }
    }
  });

  it("a head that moves on mid-build starts again there; the old record gets no stale index", () => {
    const head0 = loaded("k10-moved");
    issuesOf(head0);
    expect(buildPointReads(head0, 0)).toBe(false);
    const head1 = commit(head0, newLevel(30));
    expect(pointReadsPending(head1)).toBe(true);
    while (!buildPointReads(head1, 0));
    expect(pointReadsPending(head1)).toBe(false);
    expect(exportPointReads(head0)).toBeNull();
    const c0 = wholeChecks();
    const on = commit(head1, switchCheck(true));
    expect(text(issuesOf(on))).toBe(text(fullOf(on)));
    expect(wholeChecks() - c0).toBe(0);
  });
});
