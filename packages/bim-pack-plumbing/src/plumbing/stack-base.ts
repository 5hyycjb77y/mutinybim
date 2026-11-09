import { straightPiece } from "@permitzip/bim-kernel";
import type { RunFitting, RunSegment, BimElement, ElementId } from "@permitzip/bim-kernel";
import { chainAt, isVerticalPiece, type VerticalChain } from "./chains";
import { stackFilter } from "./stacks";

type Elements = Readonly<Record<string, BimElement>>;

const IN = 25.4;

/**
 * The base-of-stack check (STATUS decision 10; Plumbing Demo 2, 11:35): where a
 * stack turns into the horizontal main (or into an offset), no branch may join
 * within N pipe diameters of the bend, on the stack just above it or on the
 * pipe leaving it. A firm rule, not a code clause: off unless the project turns
 * it on (`set_stack_checks`).
 *
 * Read from one branch fitting: its host pipe, the bends at the host's ends and
 * the stack those bends belong to. No model-wide read.
 */

export interface StackBendClearance {
  readonly branchId: ElementId;
  readonly hostId: ElementId;
  readonly bendId: ElementId | null;
  readonly bend: "base" | "offset";
  readonly stackKey: ElementId;
  /** Along the host pipe from the branch's centreline to where the bend ends (its takeout), mm. */
  readonly distanceMm: number;
  readonly requiredMm: number;
  /** The stack's size the rule measures in, inches. */
  readonly stackSizeIn: number;
  readonly onStack: boolean;
}

function nominalIn(seg: RunSegment): number {
  return seg.size.shape === "pipe" ? seg.size.nominalMm / IN : 0;
}

/** The stack and which of its bends a host end is joined to (through one fitting or directly). */
function bendAtEnd(elements: Elements, host: RunSegment, end: "start" | "end"): { chain: VerticalChain; bendId: ElementId | null; bend: "base" | "offset" } | null {
  const link = host.links[end];
  if (!link) return null;
  const next = elements[link.elementId];
  // The host itself in a stack: its end meets the base bend or an offset bend.
  const own = isVerticalPiece(host) || next?.kind === "run_fitting" ? chainAt(elements, host.id, stackFilter) : null;
  if (next?.kind === "run_fitting" && !next.host) {
    if (own && own.base?.fittingId === next.id) return { chain: own, bendId: next.id, bend: "base" };
    if (own && own.offsetBends.includes(next.id)) return { chain: own, bendId: next.id, bend: "offset" };
    // The host leaves a stack's base bend (the building drain).
    const out = next.ports.find((p) => p.id !== link.port)?.link;
    const beyond = out ? elements[out.elementId] : undefined;
    if (beyond?.kind === "run_segment" && isVerticalPiece(beyond)) {
      const c = chainAt(elements, beyond.id, stackFilter);
      if (c?.base?.fittingId === next.id && c.base.drainId === host.id) return { chain: c, bendId: next.id, bend: "base" };
      if (c?.offsetBends.includes(next.id)) return { chain: c, bendId: next.id, bend: "offset" };
    }
    return null;
  }
  if (next?.kind === "run_segment") {
    // Joined straight to the next piece, no fitting between.
    const c = isVerticalPiece(next) ? chainAt(elements, next.id, stackFilter) : null;
    if (c?.base && c.base.fittingId === null && c.base.drainId === host.id) return { chain: c, bendId: null, bend: "base" };
    if (own?.base && own.base.fittingId === null && own.base.drainId === next.id) return { chain: own, bendId: null, bend: "base" };
  }
  return null;
}

function stackSizeIn(elements: Elements, chain: VerticalChain): number {
  const lowest = elements[chain.pieces[0] ?? ""];
  return lowest?.kind === "run_segment" ? nominalIn(lowest) : 0;
}

/** Null when the branch is far enough (or isn't near a stack bend); else how close it is. */
export function stackBendClearanceOf(elements: Elements, fitting: RunFitting, diameters: number): StackBendClearance | null {
  if (!fitting.host || fitting.ports.length === 0) return null;
  const host = elements[fitting.host.segmentId];
  if (host?.kind !== "run_segment" || host.domain !== "pipe") return null;
  // Measured from where each bend ends, not its vertex: a long-sweep 4" bend takes a foot of the pipe.
  const piece = straightPiece(elements, host);
  const length = piece.lengthMm + piece.cutStart + piece.cutEnd;
  let worst: StackBendClearance | null = null;
  for (const end of ["start", "end"] as const) {
    const at = bendAtEnd(elements, host, end);
    if (!at) continue;
    const size = stackSizeIn(elements, at.chain);
    if (size <= 0) continue;
    const distanceMm = end === "start" ? fitting.host.s - piece.cutStart : length - piece.cutEnd - fitting.host.s;
    const requiredMm = diameters * size * IN;
    if (distanceMm + 0.5 >= requiredMm) continue;
    const c: StackBendClearance = { branchId: fitting.id, hostId: host.id, bendId: at.bendId, bend: at.bend, stackKey: at.chain.key, distanceMm: Math.max(0, distanceMm), requiredMm, stackSizeIn: size, onStack: at.chain.pieces.includes(host.id) };
    if (!worst || c.distanceMm < worst.distanceMm) worst = c;
  }
  return worst;
}
