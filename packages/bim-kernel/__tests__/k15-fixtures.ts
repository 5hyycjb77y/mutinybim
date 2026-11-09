import { DEFAULT_SETTINGS, applyChangeset, builtinPartType, canonicalJson, planCommit, withUpgradePolicy, type BimElement, type Changeset, type Command, type CommandRequest, type LibraryEntry, type ModelState, type PartInstance, type RunFitting, type RunSegment } from "../src";

/**
 * A small model for round 15's connect tests (lane K15): one level, the
 * starter fixtures and terminals, and a commit loop that checks every
 * changeset replays to the same model. The tests own every number.
 */

export const FT = 304.8;
export const IN = 25.4;
const NOW = () => "2026-11-04T00:00:00.000Z";

export const SAN = { id: "sys-san", kind: "sanitary" as const, name: "Sanitary" };
export const CW = { id: "sys-cw", kind: "domestic_cold_water" as const, name: "Domestic Cold Water" };
export const SA = { id: "sys-sa", kind: "supply_air" as const, name: "Supply Air 1" };
export const PVC = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "pvc" as const });
export const COPPER = (inches: number) => ({ shape: "pipe" as const, nominalMm: inches * IN, material: "copper" as const });

export function lib(id: string): LibraryEntry {
  const t = builtinPartType(id);
  if (!t) throw new Error(`starter library has no ${id}`);
  return t;
}
export const WC = lib("builtin:water-closet-floor@1");
export const LAV = lib("builtin:lavatory-wall@1");
export const DIFFUSER = lib("builtin:supply-diffuser-24@1");

let counter = 0;

/** Which peer features the command is decided with: every one (a current server), unless a test says otherwise. */
export type Policy = (feature: string) => boolean;
export const ALL: Policy = () => true;

export class K15Model {
  head: ModelState;
  readonly log: Changeset[] = [];
  constructor() {
    this.head = { modelId: "k15", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    this.ok({ type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  }
  submit(command: Command, policy: Policy = ALL) {
    counter += 1;
    const base = this.head.revision;
    const req: CommandRequest = { idempotencyKey: `k15-${counter}-key`, baseRevision: base, actor: { id: "avery", name: "Avery", kind: "human" }, command, clientSessionId: "tab" };
    const decision = withUpgradePolicy(policy, () => planCommit(this.head, this.log.filter((cs) => cs.revision > base), req, NOW, this.log));
    if (decision.ok) {
      expect(canonicalJson(applyChangeset(this.head, decision.changeset))).toBe(canonicalJson(decision.model));
      this.head = decision.model;
      this.log.push(decision.changeset);
    }
    return decision;
  }
  ok(command: Command, policy: Policy = ALL): Changeset {
    const d = this.submit(command, policy);
    if (!d.ok) throw new Error(`expected ${command.type} to commit: ${d.error.message}`);
    return d.changeset;
  }
  refused(command: Command, policy: Policy = ALL): string {
    const before = this.head;
    const d = this.submit(command, policy);
    if (d.ok) throw new Error(`expected ${command.type} to be refused`);
    expect(this.head).toBe(before);
    return d.error.message;
  }
  place(partId: string, entry: LibraryEntry, x: number, y: number, offsetMm: number, mark: string, rotationDeg?: number): void {
    this.ok({ type: "place_part", partId, typeId: entry.id, ...(this.head.elements[entry.id] ? {} : { partType: entry.definition }), levelId: "lvl-1", position: { x, y }, offsetMm, mark, ...(rotationDeg !== undefined ? { rotationDeg } : {}) });
  }
  el(id: string): BimElement {
    const found = this.head.elements[id];
    if (!found) throw new Error(`missing ${id}`);
    return found;
  }
  seg(id: string): RunSegment {
    const el = this.el(id);
    if (el.kind !== "run_segment") throw new Error(`${id} is a ${el.kind}`);
    return el;
  }
  part(id: string): PartInstance {
    const el = this.el(id);
    if (el.kind !== "part") throw new Error(`${id} is a ${el.kind}`);
    return el;
  }
  segs(prefix = ""): RunSegment[] {
    return Object.values(this.head.elements).filter((e): e is RunSegment => e.kind === "run_segment" && e.id.startsWith(prefix));
  }
  fits(prefix = ""): RunFitting[] {
    return Object.values(this.head.elements).filter((e): e is RunFitting => e.kind === "run_fitting" && e.id.startsWith(prefix));
  }
  /** The branch fittings hosted on a run. */
  takeoffsOn(segmentId: string): RunFitting[] {
    return this.fits().filter((f) => f.host?.segmentId === segmentId);
  }
}

/** Height of a straight run's centreline at plan x (a run along x). */
export function zAtX(seg: RunSegment, x: number): number {
  const t = (x - seg.start.x) / (seg.end.x - seg.start.x);
  return seg.start.z + (seg.end.z - seg.start.z) * t;
}
