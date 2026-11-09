/**
 * Round 11 lane G11 fixtures: a small model to freeze (round 7's synthetic
 * floor: walls, spaces, determinations), a person who freezes it, and the
 * lifecycle command runner. Synthetic, no client data.
 */
import type { AuthorRef, BimElement, ModelState } from "../src";
import { executeLifecycleCommand, type LifecycleCommand } from "../src/lifecycle/commands";
import { withUpgradePolicy } from "../src/schema-version/registry";

export const KS: AuthorRef = { provider: "unsigned", subject: "user-ks", kind: "person", displayName: "K. Example" };

/** Every peer reads `gates:records` (a peer of this release). */
export const allPeers = <T>(fn: () => T): T => withUpgradePolicy(() => true, fn);

export function lifecycle(m: ModelState, c: LifecycleCommand): ModelState {
  const r = allPeers(() => executeLifecycleCommand(m, c));
  if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
  return { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
}

export function wall(id: string, x0: number, y0: number, x1: number, y1: number, extra: Readonly<Record<string, unknown>> = {}): BimElement {
  return { version: 1, authoredRev: {}, partition: { level: "Level 1", zone: "Z1", discipline: "architecture" }, id, kind: "wall", start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, thickness: 150, height: 3000, wallType: "Partition", ...extra } as unknown as BimElement;
}

export function withElements(m: ModelState, els: readonly BimElement[]): ModelState {
  return { ...m, elements: { ...m.elements, ...Object.fromEntries(els.map((e) => [e.id, e])) } };
}
