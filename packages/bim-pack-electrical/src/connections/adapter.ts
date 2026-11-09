import type { BimElement, PartInstance, MemberCandidate, SourceInfo, TradeAdapter, ServiceRole } from "@permitzip/bim-kernel";
import { bestBalancedGroup, membersVa } from "./balance";
import { equipmentNameplate } from "./equipment";
import { hasPositions, distributionOf, electricalConnectorIds, electricalConnectorOf, electricalName, feederRefusal, hotConductors, loadRefusal, phaseOfSlot, PHASE_NAMES, type DistributionInfo } from "./systems";

type Elements = Readonly<Record<string, BimElement>>;

/** The breaker most branch circuits get unless the engineer or the equipment says otherwise. */
export const DEFAULT_BRANCH_BREAKER_A = 20;

function mocpOf(elements: Elements, part: PartInstance): number | null {
  return equipmentNameplate(elements, part).mocpA;
}

export const electricalAdapter: TradeAdapter = {
  trade: "electrical",

  source(elements, part): SourceInfo | null {
    const d = distributionOf(elements, part);
    if (!d) return null;
    return { name: d.name, port: d.port, spaces: hasPositions(d.kind) ? d.spaces : "none", input: d.input, ...(d.alternateInput ? { alternateInputs: [d.alternateInput] } : {}) };
  },

  connectors(elements, part) {
    return electricalConnectorIds(elements, part);
  },

  positionsNeeded(elements, member, role) {
    if (role === "feeder") {
      const d = distributionOf(elements, member.part);
      return d ? hotConductors(d.supply) : null;
    }
    return electricalConnectorOf(elements, member.part, member.connector)?.poles ?? null;
  },

  refusal(elements, source, positions, member, role) {
    const src = distributionOf(elements, source);
    if (!src) return `${electricalName(elements, source)} is not distribution equipment with a voltage, so nothing can be fed from it`;
    const who = electricalName(elements, member.part);
    const poles = positions.length > 0 ? positions.length : null;
    if (role === "feeder") {
      const d = distributionOf(elements, member.part);
      if (!d) return `${who} is not distribution equipment`;
      return feederRefusal(who, d.supply, poles, src.name, src.system);
    }
    return branchRefusal(elements, src, positions, member);
  },

  positionsRefusal(elements, source, positions) {
    const src = distributionOf(elements, source);
    if (!src) return null;
    if (!hasPositions(src.kind)) return positions.length > 0 ? `${src.name} is a ${src.kind.replace(/_/g, " ")}; what it feeds takes no breaker positions on it` : null;
    if (positions.length === 0) return `Choose the circuit number on ${src.name}`;
    const sorted = [...positions].sort((a, b) => a - b);
    const hots = hotConductors(src.system);
    if (sorted.length > hots) return `${src.name} has ${hots} hot conductor${hots === 1 ? "" : "s"}, so a breaker on it has at most ${hots} pole${hots === 1 ? "" : "s"}`;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1] ?? 0;
      const cur = sorted[i] ?? 0;
      if (cur - prev !== 2) return `A ${sorted.length}-pole breaker takes circuits next to each other in one column (like ${sorted[0]},${(sorted[0] ?? 0) + 2}${sorted.length > 2 ? `,${(sorted[0] ?? 0) + 4}` : ""}); ${sorted.join(",")} aren't`;
    }
    const phases = new Set(sorted.map((s) => phaseOfSlot(s, src.system)));
    if (phases.size !== sorted.length) return `Circuits ${sorted.join(",")} on ${src.name} share phase ${PHASE_NAMES[phaseOfSlot(sorted[0] ?? 1, src.system)]}`;
    if (src.spaces !== null) {
      const over = sorted.find((s) => s > (src.spaces ?? 0));
      if (over !== undefined) return `${src.name} has ${src.spaces} circuits; there is no circuit ${over}`;
    }
    return null;
  },

  defaultDesign(elements, members, role: ServiceRole, positions) {
    if (positions.length === 0) return {};
    if (role === "feeder") {
      const d = members[0] ? distributionOf(elements, members[0].part) : null;
      const rating = d?.mainA ?? d?.busA ?? null;
      return rating ? { electrical: { ratingA: rating } } : {};
    }
    const only = members.length === 1 ? members[0] : undefined;
    const mocp = only ? mocpOf(elements, only.part) : null;
    return { electrical: { ratingA: mocp ?? DEFAULT_BRANCH_BREAKER_A } };
  },

  rankPositions(elements, source, candidates, members, role, except) {
    if (candidates.length <= 1) return candidates[0] ?? null;
    return bestBalancedGroup(elements, source, candidates, membersVa(elements, members, role), except);
  },
};

/** Why a panel (already read as `src`) can't serve a load connector through `positions`, or null when it can. */
export function branchRefusal(elements: Elements, src: DistributionInfo, positions: readonly number[], member: MemberCandidate): string | null {
  const who = electricalName(elements, member.part);
  const poles = positions.length > 0 ? positions.length : null;
  const demand = electricalConnectorOf(elements, member.part, member.connector);
  if (!demand) return `${who} has no voltage on its ${member.connector} connector; set it before circuiting it`;
  const why = loadRefusal(who, demand, src.name, src.system);
  if (why) return why;
  if (poles !== null && poles !== demand.poles) return `${who} needs a ${demand.poles}-pole circuit; this circuit has ${poles} pole${poles === 1 ? "" : "s"}`;
  return null;
}

/** Lowest-numbered free positions at a numbered source for a breaker of `poles` poles, or null when none fit. */
export function firstFreePositions(spaces: number | null, occupied: ReadonlySet<number>, poles: number, valid: (positions: readonly number[]) => boolean): number[] | null {
  return freePositionGroups(spaces, occupied, poles, valid, 1)[0] ?? null;
}

/** Every free group of positions a breaker of `poles` poles could take, lowest first (at most `limit` of them). */
export function freePositionGroups(spaces: number | null, occupied: ReadonlySet<number>, poles: number, valid: (positions: readonly number[]) => boolean, limit = Number.POSITIVE_INFINITY): number[][] {
  if (poles === 0) return [[]];
  const last = spaces ?? Math.max(0, ...occupied) + 2 * poles + 2;
  const out: number[][] = [];
  for (let s = 1; s <= last && out.length < limit; s++) {
    const group = Array.from({ length: poles }, (_, i) => s + 2 * i);
    if (group.some((p) => occupied.has(p) || p > last)) continue;
    if (valid(group)) out.push(group);
  }
  return out;
}

export type { MemberCandidate };
