/**
 * @jest-environment node
 *
 * Round 10 lane K10: moving the five round-1 kinds' connector ends, where
 * each end sits, where each element sits and their stored shape onto the
 * Mechanical add-on's kind rows changes no answer on any stored model.
 * Checked on the stored-changeset fixtures written by round 8b (rounds 1–8b),
 * the demo, the heavy model and the full-BIM XS trees against frozen copies
 * of round 9's code (the map-based index with its fixed ends table, round
 * 9's `pointOf` and `anchorOf` switches): every child, parent, hosted tap,
 * disconnected element and walk rank; every connection end's position;
 * every element's anchor; the same issues and the same derived state; and
 * every stored record of the five kinds has the shape its row declares.
 *
 * Fails on round 9's code: the rows carry no `connectorEnds`, `shape` or
 * `anchor`, and `kindShapeAccepts` doesn't exist.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  add,
  anchorOf,
  connectorPointOf,
  elementKindTable,
  freezeElements,
  kindShapeAccepts,
  recomputeDerived,
  scale,
  sub,
  unit,
  validateModel,
  type BimElement,
  type ConnectorEnd,
  type ModelState,
  type ValidationIssue,
  type Vec2,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { HEAVY_TIERS, createDemoModel, createHeavyModel } from "@permitzip/bim-pack-mechanical/seed";
import { NetworkIndex } from "../src/network";
import { NetworkIndex as Round9Index } from "./reference/network-index";

interface Fixture {
  readonly scenario: string;
  readonly head: ModelState;
  readonly expected: { readonly issues: readonly ValidationIssue[]; readonly derivedChanged: number };
}

const DIR = path.join(__dirname, "fixtures", "stored-changesets");
/** The fixtures round 8b's kernel wrote for the five kinds (the directory also holds other lanes' fixtures). */
const STORED = ["r1-demo", "r2-demo-edited", "r3-heavy", "r5-fullbim-xs", "r8-shared-tree"] as const;
const FIXTURES: readonly Fixture[] = STORED.map((name) => JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as Fixture);

const FIVE: ReadonlySet<string> = new Set(["equipment", "duct_segment", "tap", "elbow", "terminal"]);
const ENDS: readonly ConnectorEnd[] = ["start", "end", "in", "out", "host", "branch"];

/** Round 9's `pointOf` for the five kinds (model.ts before K10). */
function round9Point(model: ModelState, el: BimElement, end: ConnectorEnd): Vec2 {
  switch (el.kind) {
    case "duct_segment":
      return end === "start" ? el.start : el.end;
    case "equipment":
      return add(el.position, el.portOffset);
    case "elbow":
    case "terminal":
      return el.position;
    case "tap": {
      if (end === "branch") return el.position;
      const host = model.elements[el.hostId];
      if (!host || host.kind !== "duct_segment") return el.position;
      return add(host.start, scale(unit(sub(host.end, host.start)), el.s));
    }
    default:
      throw new Error(`${el.kind} isn't one of the five`);
  }
}

/** Round 9's `anchorOf` for the five kinds. */
function round9Anchor(el: BimElement): Vec2 | null {
  switch (el.kind) {
    case "equipment":
    case "tap":
    case "elbow":
    case "terminal":
      return el.position;
    case "duct_segment":
      return scale(add(el.start, el.end), 0.5);
    default:
      return null;
  }
}

const MODELS: ReadonlyArray<readonly [string, ModelState, Fixture | null]> = [
  ...FIXTURES.map((f) => [f.scenario, f.head, f] as const),
  ["demo", recomputeDerived(createDemoModel("k10-demo")).model, null],
  ["heavy", (() => {
    const m = createHeavyModel({ ...HEAVY_TIERS.S, modelId: "k10-heavy" });
    return { ...m, elements: freezeElements(m.elements) };
  })(), null],
  ["fullbim-xs", (() => {
    const m = createFullBimModel({ ...FULL_BIM_TIERS.XS, modelId: "k10-xs" });
    return { ...m, elements: freezeElements(m.elements) };
  })(), null],
];

describe("k10-old-models-open-identically", () => {
  it.each(MODELS.map(([name, model]) => [name, model] as const))("%s: the index from the kind rows answers exactly as round 9's fixed table", (_name, model) => {
    const rows = new NetworkIndex(model.connections, model.elements);
    const round9 = new Round9Index(model.connections, model.elements);
    expect(rows.isTree).toBe(round9.isTree);
    expect(rows.disconnected()).toEqual(round9.disconnected());
    for (const id of Object.keys(model.elements)) {
      expect([id, rows.children(id)]).toEqual([id, round9.children(id)]);
      expect([id, rows.parent(id)]).toEqual([id, round9.parent(id)]);
      expect([id, rows.hostedTaps(id)]).toEqual([id, round9.hostedTaps(id)]);
      expect([id, rows.airflowRank(id as BimElement["id"])]).toEqual([id, round9.airflowRank(id as BimElement["id"])]);
    }
  });

  it.each(MODELS.map(([name, model]) => [name, model] as const))("%s: every connection end sits where round 9 put it, and every element's anchor is round 9's", (_name, model) => {
    let ends = 0;
    for (const c of model.connections) {
      for (const ref of [c.a, c.b]) {
        const el = model.elements[ref.elementId];
        if (!el || !FIVE.has(el.kind)) continue;
        expect([ref, connectorPointOf(model, el, ref.end)]).toEqual([ref, round9Point(model, el, ref.end)]);
        ends += 1;
      }
    }
    for (const el of Object.values(model.elements)) {
      if (!FIVE.has(el.kind)) continue;
      expect([el.id, anchorOf(el)]).toEqual([el.id, round9Anchor(el)]);
      // Ends a connection doesn't use still sit where round 9 put them.
      if (el.kind === "tap") for (const end of ENDS.filter((e) => e === "host" || e === "branch")) expect(connectorPointOf(model, el, end)).toEqual(round9Point(model, el, end));
    }
    expect(ends).toBeGreaterThan(0);
  });

  it.each(MODELS.map(([name, model]) => [name, model] as const))("%s: every stored record of the five kinds has the shape its row declares", (_name, model) => {
    const table = elementKindTable();
    let checked = 0;
    for (const el of Object.values(model.elements)) {
      if (!FIVE.has(el.kind)) continue;
      const row = table.row(el.kind);
      expect(row?.shape).toBeDefined();
      if (row) expect([el.id, kindShapeAccepts(row, el)]).toEqual([el.id, true]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // r8-shared-tree is the one model whose air total round 9 corrected on purpose (a9-pipe-not-in-air-total).
  it.each(FIXTURES.filter((f) => f.scenario !== "r8-shared-tree").map((f) => [f.scenario, f] as const))("%s: the same issues and the same derived state round 8b recorded", (_name, f) => {
    expect(recomputeDerived(f.head).changedIds.length).toBe(f.expected.derivedChanged);
    expect(validateModel(f.head)).toEqual(f.expected.issues);
  });
});
