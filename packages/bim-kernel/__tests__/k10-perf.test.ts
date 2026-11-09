/**
 * @jest-environment node
 *
 * Round 10 lane K10: what reading connector ends from the add-ons' kind rows
 * costs on the topology index, the tree totals and a topology edit. Each case
 * prints `[k10 <row>] p50 … p95 …`; an internal design note
 * records the runs on round 9's code and on this lane's. Ceilings here are
 * coarse so a loaded laptop doesn't fail them; the budgets are the gate's.
 *
 * K10_PERF=1 runs it; K10_PERF_TIER picks the tier (250k by default; 1M only
 * through the shared stack's heavy lock).
 */
import { add, draftElements, elementsOfKind, freezeElements, recomputeDerivedAfter, scale, sub, treeNetwork, unit, type BimElement, type ConnectorEnd, type ModelState, type Vec2 } from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { createFullBimModel, FULL_BIM_TIERS } from "@permitzip/bim-first-party/seed";
import { PackSet } from "@permitzip/bim-kernel/packs";
import { computeAirflow } from "@permitzip/bim-pack-mechanical";
import { NetworkIndex, networkOf } from "../src/network";
import * as network from "../src/network";
// Imported from its module, as validate.ts does (not through the package index).
import { connectorPointUnlessKept } from "../src/model";
import { NetworkIndex as Round9Index } from "./reference/round9-network-index";
import * as kernel from "@permitzip/bim-kernel";

type Tier = keyof typeof FULL_BIM_TIERS;

function isTier(value: string): value is Tier {
  return value in FULL_BIM_TIERS;
}

function p50p95(samples: readonly number[]): { readonly p50: number; readonly p95: number } {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] ?? 0;
  return { p50: Math.round(at(0.5) * 100) / 100, p95: Math.round(at(0.95) * 100) / 100 };
}

function report(row: string, samples: readonly number[], extra = ""): void {
  const s = p50p95(samples);
  process.stderr.write(`[k10 ${row}] p50 ${s.p50} ms, p95 ${s.p95} ms (n=${samples.length})${extra ? `; ${extra}` : ""}\n`);
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

/** The ends resolver this build has (`connectorEndsTable` from K10 on), or the kernel's fixed `downstreamEndsOf` on round 9. */
type EndsLookup = (kind: string) => readonly string[];
function endsLookup(set: PackSet): EndsLookup {
  const resolve: unknown = Reflect.get(kernel, "connectorEndsTable");
  if (typeof resolve === "function") {
    const table: unknown = resolve(set);
    const downstream: unknown = typeof table === "object" && table !== null ? Reflect.get(table, "downstream") : undefined;
    if (typeof downstream === "function") return (kind) => downstream.call(table, kind);
  }
  const fixed: unknown = Reflect.get(network, "downstreamEndsOf");
  if (typeof fixed !== "function") throw new Error("this build has neither connectorEndsTable nor downstreamEndsOf");
  return (kind) => fixed(kind);
}

/** Round 9's `pointOf` (model.ts before K10), for the A/B row. */
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
      throw new Error(`${el.kind} has no network connectors`);
  }
}

const tierName = process.env.K10_PERF_TIER ?? "250k";
/** Interleaved rounds per A/B row (the first is a warm-up); K10_AB_ROUNDS raises it for a steadier median. */
const AB_ROUNDS = Number(process.env.K10_AB_ROUNDS ?? "7");
const run = process.env.K10_PERF === "1" ? describe : describe.skip;
// Millisecond ceilings hold on calibrated machines; shared CI runners set MUTINYBIM_PERF_BUDGETS=relative.
const ABSOLUTE_BUDGETS = process.env.MUTINYBIM_PERF_BUDGETS !== "relative";

run(`k10 add-on connector ends at ${tierName}`, () => {
  if (!isTier(tierName)) throw new Error(`K10_PERF_TIER=${tierName} isn't a full-BIM tier (${Object.keys(FULL_BIM_TIERS).join(", ")})`);
  installFirstPartyAddOns();
  const built = createFullBimModel({ ...FULL_BIM_TIERS[tierName], modelId: `k10-${tierName}` });
  const head: ModelState = { ...built, elements: freezeElements(built.elements) };
  const elements: readonly BimElement[] = Object.values(head.elements);
  const terminals = elementsOfKind(head.elements, "terminal");
  const segments = elementsOfKind(head.elements, "duct_segment");

  it(`kinds.connector_ends.resolve.${tierName}: the set's ends resolved cold, then every element's downstream ends read`, () => {
    let reads = 0;
    const s = time(5, () => {
      // A fresh set over the same first-party base: nothing memoised yet.
      const lookup = endsLookup(PackSet.create([]));
      reads = 0;
      for (const el of elements) reads += lookup(el.kind).length;
    });
    report(`kinds.connector_ends.resolve.${tierName}`, s, `${elements.length} elements, ${reads} downstream ends`);
    expect(reads).toBeGreaterThan(0);
    if (ABSOLUTE_BUDGETS) expect(p50p95(s).p50).toBeLessThan(5_000);
  });

  it(`network.index.build.${tierName}: a fresh revision's topology index, built in full`, () => {
    const s = time(5, () => {
      networkOf({ ...head, elements: draftElements(head.elements) });
    });
    report(`network.index.build.${tierName}`, s, `${elements.length} elements`);
    if (ABSOLUTE_BUDGETS) expect(p50p95(s).p50).toBeLessThan(30_000);
  });

  it(`network.tree.totals.${tierName}: the air total over every tree`, () => {
    networkOf(head);
    const s = time(5, () => {
      expect(computeAirflow(head).size).toBeGreaterThan(0);
    });
    report(`network.tree.totals.${tierName}`, s);
  });

  it(`network.index.after.${tierName}: one segment rewritten, its rows rebuilt`, () => {
    const prev = networkOf(head);
    const s = time(9, (i) => {
      const seg = segments[(i * 977) % segments.length];
      if (!seg) return;
      const w: Record<string, BimElement> = draftElements(head.elements);
      w[seg.id] = { ...seg, version: seg.version + 1 };
      expect(NetworkIndex.after(prev, freezeElements(w), [seg.id])).not.toBeNull();
    });
    report(`network.index.after.${tierName}`, s);
  });

  it(`network.ab.${tierName}: round 9's fixed-table index and the kind-row index, interleaved on one model (build, one-edit rebuild, tree totals)`, () => {
    const ab = (label: string, fresh: () => void, round9: () => void) => {
      const now: number[] = [];
      const was: number[] = [];
      for (let i = 0; i < AB_ROUNDS; i++) {
        const first = i % 2 === 0;
        const t0 = performance.now();
        if (first) fresh();
        else round9();
        const t1 = performance.now();
        if (first) round9();
        else fresh();
        const t2 = performance.now();
        if (i === 0) continue;
        (first ? now : was).push(t1 - t0);
        (first ? was : now).push(t2 - t1);
      }
      report(`${label}.${tierName} (kind rows)`, now);
      report(`${label}.${tierName} (round 9)`, was);
    };
    ab(
      "ab.network.index.build",
      () => new NetworkIndex(head.connections, draftElements(head.elements)),
      () => new Round9Index(head.connections, draftElements(head.elements)),
    );
    const freshIndex = new NetworkIndex(head.connections, head.elements);
    const round9Index = new Round9Index(head.connections, head.elements);
    const seg = segments[segments.length >> 1];
    if (!seg) throw new Error("no segment");
    const w: Record<string, BimElement> = draftElements(head.elements);
    w[seg.id] = { ...seg, version: seg.version + 1 };
    const edited = freezeElements(w);
    ab(
      "ab.network.index.after",
      () => expect(NetworkIndex.after(freshIndex, edited, [seg.id])).not.toBeNull(),
      () => expect(Round9Index.after(round9Index, edited, [seg.id])).not.toBeNull(),
    );
    const total = treeNetwork().totals[0];
    if (!total) throw new Error("no tree total");
    const read = freshIndex.readerFor(head.elements);
    ab(
      "ab.network.tree.totals_by_slot",
      () => freshIndex.totalsBySlot(total, read),
      () => round9Index.totalsBySlot(total, read),
    );
    // validate.full places both ends of every connection: the row's `point` against round 9's switch.
    const connectionEnds: Array<readonly [BimElement, ConnectorEnd]> = [];
    for (const c of head.connections) {
      for (const ref of [c.a, c.b]) {
        const el = head.elements[ref.elementId];
        if (el) connectionEnds.push([el, ref.end]);
      }
    }
    let sink = 0;
    ab(
      "ab.connector_points.every_connection",
      () => {
        for (const [el, end] of connectionEnds) sink += connectorPointUnlessKept(head, el, end)?.x ?? 0;
      },
      () => {
        for (const [el, end] of connectionEnds) sink += round9Point(head, el, end).x;
      },
    );
    expect(Number.isFinite(sink)).toBe(true);
  });

  it(`derived.topology_edit.${tierName}: one terminal removed, derived values after it`, () => {
    const s = time(9, (i) => {
      const t = terminals[(i * 977) % terminals.length];
      if (!t) return;
      const w = draftElements(head.elements);
      delete w[t.id];
      recomputeDerivedAfter(head, w, [t.id]);
    });
    report(`derived.topology_edit.${tierName}`, s);
  });
});
