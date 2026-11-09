import { type BimElement, type PartInstance, linksFedFrom, serviceLinkName, type ServiceLinkCommand, type ServiceLink } from "@permitzip/bim-kernel";
import { electricalAdapter } from "./adapter";
import { imbalance, linkInventory, type PhaseState } from "./balance";
import { existingPhaseOf } from "./panel";
import { distributionOf, hotConductors, phaseOfSlot, PHASE_NAMES } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/**
 * "Rebalance panel": slot moves that even out the connected load on a
 * panel's phases. Deterministic (same model, same moves), and conservative:
 * it moves a circuit, or swaps two circuits with the same number of poles,
 * one step at a time, taking the step that helps most, until no step helps
 * by at least a volt-amp or `maxMoves` circuits have moved. Three-pole
 * breakers on a three-phase panel are already balanced and never move;
 * circuits the engineer keeps, and existing circuits on a renovation (made in
 * an earlier phase than the one being designed), stay where they are.
 * Rebalancing an existing
 * panel's circuits is generic practice (internal design note); what is on
 * each circuit never changes.
 */

export interface RebalanceMove {
  readonly linkId: string;
  /** "L1-7" before, "L1-12" after. */
  readonly from: string;
  readonly to: string;
  readonly description: string;
  readonly va: number;
  readonly fromPositions: readonly number[];
  readonly toPositions: readonly number[];
  readonly fromPhases: readonly string[];
  readonly toPhases: readonly string[];
}

export interface RebalancePlan {
  readonly panelId: string;
  readonly panelName: string;
  /** Connected VA per phase now and after the moves (A, B[, C]). */
  readonly before: readonly { readonly phase: string; readonly va: number }[];
  readonly after: readonly { readonly phase: string; readonly va: number }[];
  /** The spread between the most and least loaded phase, VA. */
  readonly spreadBefore: number;
  readonly spreadAfter: number;
  readonly moves: readonly RebalanceMove[];
  /** The edit that applies every move at once; null when nothing would move. */
  readonly command: Extract<ServiceLinkCommand, { type: "reposition_service_links" }> | null;
  /** One sentence for the person. */
  readonly message: string;
  /** Existing circuits left where they are (present only when there are some). */
  readonly existingKept?: readonly string[];
}

export interface RebalanceOptions {
  /** Circuits to leave where they are. */
  readonly keep?: readonly string[];
  /** At most this many circuits move (default 12). */
  readonly maxMoves?: number;
}

interface Slot {
  readonly link: ServiceLink;
  /** What each pole carries (pole k sits at positions[k]): a branch splits evenly, a fed panel's phase i lands on pole i. */
  readonly poleVa: readonly number[];
  readonly va: number;
  readonly original: readonly number[];
  positions: number[];
}

const MIN_GAIN_VA = 1;

export function planRebalance(elements: Elements, panelId: string, options: RebalanceOptions = {}): RebalancePlan | null {
  const part = elements[panelId];
  const info = part?.kind === "part" ? distributionOf(elements, part) : null;
  if (!info || part?.kind !== "part") return null;
  const panel: PartInstance = part;
  const hots = hotConductors(info.system);
  const phaseNames = PHASE_NAMES.slice(0, hots);
  const keep = new Set(options.keep ?? []);
  const existingKept: string[] = [];
  const maxMoves = options.maxMoves ?? 12;
  const slots: Slot[] = [];
  for (const link of linksFedFrom(elements, panelId)) {
    if (link.trade !== "electrical" || link.source.positions.length === 0) continue;
    const inv = linkInventory(elements, info.system, link);
    const positions = [...link.source.positions].sort((a, b) => a - b);
    if (existingPhaseOf(elements, link) !== null) {
      keep.add(link.id);
      existingKept.push(serviceLinkName(elements, link));
    }
    const poleVa = positions.map((p) => inv.perPhase[phaseOfSlot(p, info.system)] ?? 0);
    slots.push({ link, poleVa, va: inv.va, original: positions, positions: [...positions] });
  }
  const phaseOf = (s: number) => phaseOfSlot(s, info.system);
  const stateOf = (): PhaseState => {
    const va: [number, number, number] = [0, 0, 0];
    const poles: [number, number, number] = [0, 0, 0];
    for (const s of slots) {
      s.positions.forEach((p, k) => {
        va[phaseOf(p) as 0 | 1 | 2] += s.poleVa[k] ?? 0;
        poles[phaseOf(p) as 0 | 1 | 2] += 1;
      });
    }
    return { va, poles, hots };
  };
  const totals = (st: PhaseState) => phaseNames.map((phase, i) => ({ phase, va: Math.round((st.va[i] ?? 0) * 100) / 100 }));
  const beforeState = stateOf();
  const spread = (st: PhaseState) => imbalance(st).vaSpread;
  const spreadBefore = spread(beforeState);
  const movable = (s: Slot) => !keep.has(s.link.id) && s.positions.length < hots && s.va > 0;
  const valid = (group: readonly number[]) => electricalAdapter.positionsRefusal(elements, panel, group) === null;
  const occupiedBy = (): Map<number, Slot> => {
    const m = new Map<number, Slot>();
    for (const s of slots) for (const p of s.positions) m.set(p, s);
    return m;
  };
  const moved = new Set<string>();
  for (let step = 0; step < 200; step++) {
    const current = spread(stateOf());
    const occ = occupiedBy();
    // Most even first; on a tie, the step that moves the least load, then the first by circuit and slot.
    const pick: { best: { gain: number; moved: number; apply: () => void; key: string } | null } = { best: null };
    const consider = (gain: number, moved: number, key: string, apply: () => void) => {
      if (gain < MIN_GAIN_VA) return;
      const b = pick.best;
      const tie = b !== null && Math.abs(gain - b.gain) <= 1e-6;
      if (!b || gain > b.gain + 1e-6 || (tie && (moved < b.moved - 1e-6 || (Math.abs(moved - b.moved) <= 1e-6 && key < b.key)))) pick.best = { gain, moved, key, apply };
    };
    const canMoveMore = (ids: readonly string[]) => new Set([...moved, ...ids]).size <= maxMoves;
    for (const s of slots) {
      if (!movable(s) || !canMoveMore([s.link.id])) continue;
      const poles = s.positions.length;
      // Moves into free space.
      for (let first = 1; first <= (info.spaces ?? 0); first++) {
        const group = Array.from({ length: poles }, (_, i) => first + 2 * i);
        if (group.some((g) => g > (info.spaces ?? 0) || (occ.has(g) && occ.get(g) !== s))) continue;
        if (group.every((g, i) => g === s.positions[i]) || !valid(group)) continue;
        const was = s.positions;
        s.positions = group;
        const gain = current - spread(stateOf());
        s.positions = was;
        consider(gain, s.va, `m:${s.link.id}:${String(first).padStart(4, "0")}`, () => {
          s.positions = group;
        });
      }
      // Swaps with another circuit of the same poles.
      for (const t of slots) {
        if (t === s || t.link.id < s.link.id || !movable(t) || t.positions.length !== poles || !canMoveMore([s.link.id, t.link.id])) continue;
        const a = s.positions;
        const b = t.positions;
        s.positions = b;
        t.positions = a;
        const gain = current - spread(stateOf());
        s.positions = a;
        t.positions = b;
        consider(gain, s.va + t.va, `s:${s.link.id}:${t.link.id}`, () => {
          s.positions = b;
          t.positions = a;
        });
      }
    }
    const chosen = pick.best;
    if (!chosen) break;
    chosen.apply();
    for (const s of slots) if (s.positions.some((p, i) => p !== s.original[i])) moved.add(s.link.id);
  }
  const afterState = stateOf();
  const changed = slots.filter((s) => s.positions.some((p, i) => p !== s.original[i]));
  const nameAt = (s: Slot, positions: readonly number[]) => serviceLinkName(elements, { ...s.link, source: { ...s.link.source, positions } });
  const moves: RebalanceMove[] = changed
    .map((s) => ({
      linkId: s.link.id,
      from: nameAt(s, s.original),
      to: nameAt(s, s.positions),
      description: s.link.description,
      va: Math.round(s.va),
      fromPositions: s.original,
      toPositions: [...s.positions],
      fromPhases: s.original.map((p) => PHASE_NAMES[phaseOf(p)] ?? "A"),
      toPhases: s.positions.map((p) => PHASE_NAMES[phaseOf(p)] ?? "A"),
    }))
    .sort((x, y) => (x.fromPositions[0] ?? 0) - (y.fromPositions[0] ?? 0));
  const spreadAfter = spread(afterState);
  const r = (v: number) => Math.round(v).toLocaleString("en-US");
  const message =
    moves.length === 0
      ? spreadBefore < MIN_GAIN_VA
        ? `${info.name}'s phases are already even.`
        : `No slot move evens ${info.name} out further (${r(spreadBefore)} VA between the most and least loaded phase)${keep.size > existingKept.length ? " with the circuits you kept in place" : ""}.`
      : `Move ${moves.length} circuit${moves.length === 1 ? "" : "s"} on ${info.name}: the spread between phases goes from ${r(spreadBefore)} VA to ${r(spreadAfter)} VA.`;
  const existingNote = existingKept.length > 0 ? ` ${existingKept.length} existing circuit${existingKept.length === 1 ? " stays" : "s stay"} where ${existingKept.length === 1 ? "it is" : "they are"} (${existingKept.slice(0, 4).join(", ")}${existingKept.length > 4 ? ", …" : ""}).` : "";
  return {
    panelId,
    panelName: info.name,
    before: totals(beforeState),
    after: totals(afterState),
    spreadBefore,
    spreadAfter,
    moves,
    command: moves.length > 0 ? { type: "reposition_service_links", sourceId: panelId, moves: moves.map((m) => ({ linkId: m.linkId, positions: [...m.toPositions] })) } : null,
    message: `${message}${existingNote}`,
    ...(existingKept.length > 0 ? { existingKept } : {}),
  };
}
