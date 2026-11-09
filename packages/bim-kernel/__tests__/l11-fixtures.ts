/**
 * Round 11 lane L11 fixtures: a model's lineages in one process, each with
 * its own head and its own changesets (numbered after its fork pin, as the
 * model server numbers a branch's), so a copy's line is read exactly as a
 * server reads it: own changesets above the pin, the parent's below.
 */
import { asElementId, asRevision, forkState, freezeElements, type Actor, type BimElement, type Changeset, type ExecuteResult, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { lineageChain, lineageLookup, lineageSegments, forkLineage, type LineageLookup } from "../src/lineages/chain";
import type { LineageSide } from "../src/lineages/compare";
import type { Lineage, LineageRoleId } from "../src/lineages/types";
import type { AuthorRef } from "../src/authorship/types";

export const AVERY: AuthorRef = { provider: "unsigned", subject: "u-avery", kind: "person", displayName: "Avery" };
const actor: Actor = { id: "u-avery", name: "Avery", kind: "human" };

export function level(id: string, name: string, elevationMm = 0): BimElement {
  return { id: asElementId(id), version: 1, authoredRev: {}, kind: "level", name, elevationMm } as BimElement;
}

export interface Edit {
  readonly set?: readonly BimElement[];
  readonly remove?: readonly string[];
  readonly cites?: readonly string[];
}

export class Copies {
  readonly lineages = new Map<string, Lineage>();
  readonly heads = new Map<string, ModelState>();
  readonly own = new Map<string, Changeset[]>();

  constructor(
    readonly rootId: string,
    records: readonly BimElement[],
  ) {
    const demo = createDemoModel("l11-model");
    const elements: Record<string, BimElement> = {};
    for (const r of records) elements[r.id] = r;
    this.heads.set(rootId, { ...demo, revision: asRevision(0), elements: freezeElements(elements), connections: [] });
    this.own.set(rootId, []);
    this.lineages.set(rootId, { id: rootId, parent: null, role: "design_record", returnPolicy: "never", state: "open", name: "Design", createdBy: AVERY, createdAt: "2026-11-02T00:00:00Z" });
  }

  get lookup(): LineageLookup {
    return lineageLookup(this.lineages.values());
  }

  head(id: string): ModelState {
    const h = this.heads.get(id);
    if (!h) throw new Error(`no head for ${id}`);
    return h;
  }

  /** Changesets on `id`'s line in (from, head]. */
  line(id: string, from: number): Changeset[] {
    const chain = lineageChain(this.lookup, id);
    return lineageSegments(chain, from, this.head(id).revision)
      .flatMap((s) => (this.own.get(s.lineageId) ?? []).filter((cs) => cs.revision > s.from && cs.revision <= s.to))
      .sort((a, b) => a.revision - b.revision);
  }

  side(id: string, since: number): LineageSide {
    return { lineageId: id, head: this.head(id), changes: this.line(id, since) };
  }

  fork(id: string, parentId: string, role: LineageRoleId, at?: number): Lineage {
    const parent = this.lineages.get(parentId);
    if (!parent) throw new Error(`no lineage ${parentId}`);
    const parentHead = this.head(parentId);
    const revision = at ?? parentHead.revision;
    const lineage = forkLineage({ id, parent, revision, parentHead: parentHead.revision, role, name: id, createdBy: AVERY, createdAt: "2026-11-02T01:00:00Z" });
    this.lineages.set(id, lineage);
    this.heads.set(id, forkState(parentHead, revision, this.line(parentId, revision)));
    this.own.set(id, []);
    return lineage;
  }

  edit(id: string, e: Edit): Changeset {
    const head = this.head(id);
    const revision = head.revision + 1;
    const elements: Record<string, BimElement> = { ...head.elements };
    const before: Record<string, BimElement | null> = {};
    const written: BimElement[] = [];
    for (const r of e.set ?? []) {
      const prior = elements[r.id] ?? null;
      before[r.id] = prior;
      const next = { ...r, version: (prior?.version ?? 0) + 1 } as BimElement;
      elements[r.id] = next;
      written.push(next);
    }
    for (const rid of e.remove ?? []) {
      before[rid] = elements[rid] ?? null;
      delete elements[rid];
    }
    const cs: Changeset = {
      revision: asRevision(revision),
      baseRevision: head.revision,
      idempotencyKey: `${id}-${revision}`,
      actor,
      command: { type: "set_tag_text", tagId: "l11", text: "l11" },
      elements: written,
      readSet: {},
      authored: [],
      intents: [],
      rebased: false,
      committedAt: "2026-11-02T02:00:00Z",
      removedIds: (e.remove ?? []).map(asElementId),
      before,
      ...(e.cites ? { cites: e.cites } : {}),
    } as Changeset;
    this.heads.set(id, { ...head, revision: asRevision(revision), elements: freezeElements(elements) });
    this.own.get(id)?.push(cs);
    return cs;
  }

  /** Commit an executed landing (an accept back) as the next revision of `id`. */
  commit(id: string, result: ExecuteResult): Changeset {
    if (!result.ok) throw new Error(result.error.message);
    const set = result.changedIds.map((rid) => {
      const r = result.model.elements[rid];
      if (!r) throw new Error(`landing lost ${rid}`);
      return r;
    });
    return this.edit(id, { set, remove: result.removedIds });
  }
}
