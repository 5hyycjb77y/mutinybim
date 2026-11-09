import { catalogElementId } from "../catalog/model";
import { QUANTITIES, QUANTITY_KEYS, round6, type QuantityKey } from "../quantities";
import { modelSpaceLocator } from "../spaces/space-index";
import type { BimElement, ElementId, ElementKind } from "../types";
import { allocateServedBy } from "./allocation";
import { RequirementsEngine } from "./engine";
import { loadIndexOf } from "./load-index";
import { allocationPolicyOf, LOAD_POLICY_NAME } from "./policy";
import type { AllocatedActual } from "./types";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * One requirements engine per model state, for readers that only hold the
 * elements (schedule columns, tags, agent reads): the first read builds it
 * from the load index (`elementsOfKind`), and each commit carries it to the
 * next state from that commit's changed ids (`shareRequirementsEngine`, next
 * to `shareLoadIndex`), so a schedule of spaces or panels never re-reads
 * every load after an edit. Nothing is built or carried until someone reads.
 *
 * The engine is mutable: carrying moves it to the new state and the old
 * state rebuilds on its next read. A change to the model's allocation policy
 * drops it (the next read builds with the new policy).
 */

const engines = new WeakMap<object, RequirementsEngine>();
export const requirementsEngineStats = { builds: 0, carries: 0 };

const POLICY_ID = catalogElementId("load_policy", LOAD_POLICY_NAME);

function build(elements: Elements): RequirementsEngine {
  requirementsEngineStats.builds += 1;
  const engine = new RequirementsEngine({ locator: modelSpaceLocator, policy: allocationPolicyOf(elements) });
  engine.advance({ elements }, []);
  return engine;
}

/** The engine for an element record, up to date with it. */
export function requirementsEngineOf(elements: Elements): RequirementsEngine {
  const cached = engines.get(elements);
  if (cached?.isAt(elements)) return cached;
  const built = build(elements);
  engines.set(elements, built);
  return built;
}

/**
 * Move `from`'s engine to `to`, which differs only in `changedIds` (removed
 * ids included), and keep the per-source figures the edit did not touch.
 * Cost: the loads the edit touched. Returns false when `from` has no engine
 * yet (then `to` builds on first read).
 */
export function shareRequirementsEngine(from: Elements, to: Elements, changedIds: Iterable<string>): boolean {
  if (from === to) return false;
  const ids = [...changedIds];
  if (!ids.includes(POLICY_ID)) shareSourceFigures(from, to, ids);
  const engine = engines.get(from);
  if (!engine?.isAt(from)) return false;
  engines.delete(from);
  if (engines.has(to)) return true;
  if (ids.includes(POLICY_ID)) return false;
  engine.advance({ elements: to }, ids);
  engines.set(to, engine);
  requirementsEngineStats.carries += 1;
  return true;
}

// ---------------------------------------------------------------- per source

/** What one source (panel, heater, meter, interceptor) sees from the loads that name it. */
export interface SourceFigures extends AllocatedActual {
  readonly estimateIds: readonly ElementId[];
}

const bySource = new WeakMap<object, Map<ElementId, SourceFigures>>();

/**
 * Allocated vs actual for the loads that name `sourceId` (`allocateServedBy`,
 * indexed by servedBy), once per source per model state. `actual` is every
 * load that is not spread over a space or zone: devices, load points and
 * typed rows.
 */
export function sourceFiguresOf(elements: Elements, sourceId: ElementId): SourceFigures {
  let memo = bySource.get(elements);
  if (!memo) bySource.set(elements, (memo = new Map()));
  const hit = memo.get(sourceId);
  if (hit) return hit;
  const a = allocateServedBy(elements, sourceId, modelSpaceLocator(elements), allocationPolicyOf(elements));
  const estimateIds = a.groups.flatMap((g) => g.estimateIds).sort();
  const estimates = new Set(estimateIds);
  const allocated = {} as Record<QuantityKey, number>;
  const actual = {} as Record<QuantityKey, number>;
  const governing: Partial<Record<QuantityKey, "allocated" | "actual">> = {};
  for (const k of QUANTITY_KEYS) {
    // A typical unit's estimate counts once per instance at a source outside the unit (the group's factor).
    allocated[k] = round6(a.groups.reduce((sum, g) => sum + g.figures.allocated[k] * (QUANTITIES[k].add === "sum" ? g.factor : 1), 0));
    // The plain total less the estimates.
    actual[k] = QUANTITIES[k].add === "sum" ? round6(a.naive[k] - allocated[k]) : a.naive[k];
    if (allocated[k] === 0 && actual[k] === 0) continue;
    const c = round6(a.counted[k]);
    governing[k] = estimates.size === 0 || (c === actual[k] && c !== allocated[k]) ? "actual" : "allocated";
  }
  const actualIds = loadIndexOf(elements).servedBy(sourceId).filter((id) => !estimates.has(id) && elements[id]?.kind === "load_point");
  const figures: SourceFigures = { allocated, actual, counted: a.counted, governing, actualIds: [...actualIds].sort(), estimateIds };
  memo.set(sourceId, figures);
  return figures;
}

/** Edits to these change which space a load is in, a density, a value or the policy: every source re-reads. */
const RESETS: ReadonlySet<ElementKind> = new Set<ElementKind>(["space", "zone", "room", "level", "service_catalog", "run_segment", "run_fitting"]);

function isTypicalGroupRecord(el: BimElement | undefined): boolean {
  return el?.kind === "organization" && el.entry.type === "group" && el.entry.typical !== undefined;
}

/** Carry the per-source figures a commit did not touch: a load edit forgets its sources, a part edit the sources of its loads. */
function shareSourceFigures(from: Elements, to: Elements, changedIds: readonly string[]): void {
  const memo = bySource.get(from);
  if (!memo || bySource.has(to)) return;
  const stale = new Set<ElementId>();
  const sourcesOfLoad = (id: string) => {
    for (const el of [from[id], to[id]]) if (el?.kind === "load_point" && el.servedBy) stale.add(el.servedBy);
  };
  for (const id of changedIds) {
    const kinds = [from[id]?.kind, to[id]?.kind];
    if (kinds.some((k) => k !== undefined && RESETS.has(k))) return;
    // A typical's copies (or a group becoming or ceasing to be one) change how many times its loads count at every source.
    if ([from[id], to[id]].some(isTypicalGroupRecord)) return;
    // An element moved into or out of a group: its loads count differently.
    if (from[id] && to[id] && from[id]?.groupId !== to[id]?.groupId) return;
    if (kinds.includes("load_point")) sourcesOfLoad(id);
    if (kinds.includes("part")) {
      stale.add(id as ElementId);
      for (const lid of [...loadIndexOf(from).ofPart(id), ...loadIndexOf(to).ofPart(id)]) sourcesOfLoad(lid);
    }
  }
  const next = new Map<ElementId, SourceFigures>();
  for (const [id, f] of memo) if (!stale.has(id)) next.set(id, f);
  bySource.set(to, next);
}
