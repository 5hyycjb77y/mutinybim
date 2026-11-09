import { type BimElement, type PartInstance, combineNode, linksFedFrom, type ServiceLink } from "@permitzip/bim-kernel";
import { acrossFeeder, EMPTY_INVENTORY, inventoryMonoid, memberInventory, type Inventory } from "./inventory";
import { electricalLoadOf } from "./loads";
import { distributionOf, electricalConnectorOf, electricalName, hotConductors, phaseOfSlot, type VoltageSystem } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * Phase balancing at one panel: the connected VA on each phase (what the
 * aggregation engine's per-phase totals are made of: the same member loads,
 * spread over a breaker's poles, a fed panel landing on its feeder's poles),
 * and which slots even it out. Engineering targets only; nothing here picks a
 * panel or decides what goes on a circuit (internal design note).
 */

export interface PhaseState {
  /** Connected VA on A, B, C. */
  readonly va: readonly [number, number, number];
  /** Breaker poles on A, B, C (keeps circuits spread when loads are equal or unknown). */
  readonly poles: readonly [number, number, number];
  /** Phases the panel has (1, 2 or 3). */
  readonly hots: number;
}

function partOf(elements: Elements, id: string): PartInstance | null {
  const el = elements[id];
  return el?.kind === "part" ? el : null;
}

/** Connected inventory below a node, by the engine's rules (no demand). */
export function connectedInventory(elements: Elements, nodeId: string, seen: Set<string> = new Set()): Inventory {
  const part = partOf(elements, nodeId);
  const info = part ? distributionOf(elements, part) : null;
  if (!part || !info || seen.has(nodeId)) return EMPTY_INVENTORY;
  seen.add(nodeId);
  const links = linksFedFrom(elements, nodeId).filter((l) => l.trade === "electrical");
  const out = combineNode(undefined, links.map((l) => linkInventory(elements, info.system, l, seen)), inventoryMonoid);
  seen.delete(nodeId);
  return out;
}

function linkPhases(link: ServiceLink, system: VoltageSystem, poles: number): number[] {
  if (link.source.positions.length > 0) return link.source.positions.map((p) => phaseOfSlot(p, system));
  return Array.from({ length: Math.min(poles, hotConductors(system)) }, (_, i) => i);
}

/** One link's inventory at its source, in the source's phases. */
export function linkInventory(elements: Elements, system: VoltageSystem, link: ServiceLink, seen: Set<string> = new Set()): Inventory {
  if (link.role === "feeder") {
    const m = link.members[0];
    const fed = m ? partOf(elements, m.elementId) : null;
    const fedInfo = fed ? distributionOf(elements, fed) : null;
    if (!m || !fedInfo) return EMPTY_INVENTORY;
    const phases = linkPhases(link, system, hotConductors(fedInfo.supply));
    return acrossFeeder(connectedInventory(elements, m.elementId, seen), link.source.positions.length > 0 ? phases : []);
  }
  const first = link.members[0];
  const firstPart = first ? partOf(elements, first.elementId) : null;
  const poles = first && firstPart ? (electricalConnectorOf(elements, firstPart, first.connector)?.poles ?? 1) : 1;
  const phases = linkPhases(link, system, poles);
  const parts: Inventory[] = [];
  for (const m of link.members) {
    const member = partOf(elements, m.elementId);
    if (!member) continue;
    parts.push(memberInventory(electricalLoadOf(elements, link, m, electricalName(elements, member)), phases));
  }
  return combineNode(undefined, parts, inventoryMonoid);
}

/** The phase state of a panel, leaving out one link (the one being placed or moved). */
export function phaseState(elements: Elements, panelId: string, except?: string): PhaseState | null {
  const part = partOf(elements, panelId);
  const info = part ? distributionOf(elements, part) : null;
  if (!part || !info) return null;
  const va: [number, number, number] = [0, 0, 0];
  const poles: [number, number, number] = [0, 0, 0];
  for (const link of linksFedFrom(elements, panelId)) {
    if (link.trade !== "electrical" || link.id === except) continue;
    const inv = linkInventory(elements, info.system, link);
    inv.perPhase.forEach((v, i) => (va[i as 0 | 1 | 2] += v));
    for (const p of link.source.positions) poles[phaseOfSlot(p, info.system) as 0 | 1 | 2] += 1;
  }
  return { va, poles, hots: hotConductors(info.system) };
}

/** The VA a set of members would put on a circuit (a fed panel: everything below it). */
export function membersVa(elements: Elements, members: readonly { readonly part: PartInstance; readonly connector: string }[], role: ServiceLink["role"], loadClass?: string): number {
  if (role === "feeder") return members.reduce((a, m) => a + connectedInventory(elements, m.part.id).va, 0);
  const pseudo = { electrical: loadClass ? { loadClass } : undefined };
  return members.reduce((a, m) => a + electricalLoadOf(elements, pseudo, { elementId: m.part.id, connector: m.connector }, electricalName(elements, m.part)).va, 0);
}

/** How far a phase state is from even: the VA spread first, then the pole spread. */
export function imbalance(state: Pick<PhaseState, "va" | "poles" | "hots">): { readonly vaSpread: number; readonly poleSpread: number } {
  const va = state.va.slice(0, state.hots);
  const poles = state.poles.slice(0, state.hots);
  return { vaSpread: Math.max(...va) - Math.min(...va), poleSpread: Math.max(...poles) - Math.min(...poles) };
}

/** The state after adding `va` over the phases of `group`. */
export function withGroup(state: PhaseState, system: VoltageSystem, group: readonly number[], va: number): PhaseState {
  const next: [number, number, number] = [...state.va];
  const poles: [number, number, number] = [...state.poles];
  for (const s of group) {
    const p = phaseOfSlot(s, system) as 0 | 1 | 2;
    next[p] += va / group.length;
    poles[p] += 1;
  }
  return { va: next, poles, hots: state.hots };
}

/** Phases farther than this from their average are reported as unbalanced: a design target, not a code limit. */
export const PHASE_UNBALANCE_LIMIT = 0.15;
/**
 * ...and only when the worst phase is at least this many VA off the average
 * (about 8 A at 120 V). A nearly empty panel (50 VA on A, 180 VA on B) is a
 * large percentage of nothing, not something to move circuits for.
 */
export const PHASE_UNBALANCE_FLOOR_VA = 1000;

export interface PhaseUnbalance<P extends { readonly va: number }> {
  readonly worst: P;
  readonly average: number;
  /** How far the worst phase is from the average, as a fraction of it. */
  readonly fraction: number;
  /** The same distance in VA. */
  readonly offVa: number;
}

/** The worst phase when it is past both the percentage target and the absolute floor; null when the panel is even enough. */
export function phaseUnbalance<P extends { readonly va: number }>(perPhase: readonly P[]): PhaseUnbalance<P> | null {
  if (perPhase.length < 2) return null;
  const average = perPhase.reduce((a, p) => a + p.va, 0) / perPhase.length;
  if (!(average > 0)) return null;
  const worst = perPhase.reduce((w, p) => (Math.abs(p.va - average) > Math.abs(w.va - average) ? p : w));
  const offVa = Math.abs(worst.va - average);
  const fraction = offVa / average;
  if (fraction <= PHASE_UNBALANCE_LIMIT || offVa < PHASE_UNBALANCE_FLOOR_VA) return null;
  return { worst, average, fraction, offVa };
}

const ROUND = (v: number) => Math.round(v * 100) / 100;

/**
 * The candidate group that leaves the panel most even: smallest VA spread,
 * then smallest pole spread, then the lowest slot. Same model, same answer.
 */
export function bestBalancedGroup(elements: Elements, panel: PartInstance, candidates: readonly (readonly number[])[], va: number, except?: string): readonly number[] | null {
  const info = distributionOf(elements, panel);
  const state = info ? phaseState(elements, panel.id, except) : null;
  if (!info || !state || candidates.length === 0) return candidates[0] ?? null;
  let best: { group: readonly number[]; vaSpread: number; poleSpread: number } | null = null;
  for (const group of candidates) {
    const after = imbalance(withGroup(state, info.system, group, va));
    const vaSpread = ROUND(after.vaSpread);
    if (!best || vaSpread < best.vaSpread || (vaSpread === best.vaSpread && (after.poleSpread < best.poleSpread || (after.poleSpread === best.poleSpread && (group[0] ?? 0) < (best.group[0] ?? 0))))) {
      best = { group, vaSpread, poleSpread: after.poleSpread };
    }
  }
  return best?.group ?? null;
}
