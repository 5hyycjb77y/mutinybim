import { registerRevisionCarry } from "../revision-carry";
import { elementValues } from "../store";
import type { BimElement } from "../types";
import type { ConstructionStageElement } from "../qto/types";
import { constructionStageIdOf } from "../qto/group";

/**
 * Who is in which construction stage, and the stages themselves, per element
 * record, for the stage commands (delete a stage, reorder) and the stages
 * list, so they read the few records concerned instead of the model. Built
 * in one pass, then carried by moving only the changed elements
 * (`organization/members.ts` pattern).
 */

type Elements = Readonly<Record<string, BimElement>>;

export interface StageMembers {
  /** Element ids by the stage id they store (the id as written; a deleted stage still lists its stragglers). */
  readonly byStage: ReadonlyMap<string, ReadonlySet<string>>;
  /** Stage record ids. */
  readonly stageIds: ReadonlySet<string>;
}

const cache = new WeakMap<Elements, StageMembers>();

export function isConstructionStage(el: BimElement | undefined): el is ConstructionStageElement {
  return el?.kind === "construction_stage";
}

class Builder {
  readonly byStage: Map<string, ReadonlySet<string>>;
  private stageIds: ReadonlySet<string>;
  private stageIdsOwned: Set<string> | null = null;
  private readonly owned = new Map<string, Set<string>>();

  constructor(from: StageMembers | null) {
    this.byStage = new Map(from?.byStage ?? []);
    this.stageIds = from?.stageIds ?? new Set();
  }

  private members(stage: string): Set<string> {
    let set = this.owned.get(stage);
    if (!set) {
      set = new Set(this.byStage.get(stage) ?? []);
      this.owned.set(stage, set);
      this.byStage.set(stage, set);
    }
    return set;
  }

  apply(el: BimElement, by: 1 | -1): void {
    if (isConstructionStage(el)) {
      if (!this.stageIdsOwned) {
        this.stageIdsOwned = new Set(this.stageIds);
        this.stageIds = this.stageIdsOwned;
      }
      if (by > 0) this.stageIdsOwned.add(el.id);
      else this.stageIdsOwned.delete(el.id);
      return;
    }
    const stage = constructionStageIdOf(el);
    if (stage === null) return;
    const set = this.members(stage);
    if (by > 0) set.add(el.id);
    else {
      set.delete(el.id);
      if (set.size === 0) {
        this.byStage.delete(stage);
        this.owned.delete(stage);
      }
    }
  }

  done(): StageMembers {
    return { byStage: this.byStage, stageIds: this.stageIds };
  }
}

export function stageMembersOf(elements: Elements): StageMembers {
  const hit = cache.get(elements);
  if (hit) return hit;
  const b = new Builder(null);
  for (const el of elementValues(elements)) b.apply(el, 1);
  const built = b.done();
  cache.set(elements, built);
  return built;
}

/** The model's stages in their order (then by name, then id). */
export function constructionStages(elements: Elements): ConstructionStageElement[] {
  const out: ConstructionStageElement[] = [];
  for (const id of stageMembersOf(elements).stageIds) {
    const el = elements[id];
    if (isConstructionStage(el)) out.push(el);
  }
  return out.sort((a, b) => a.stage.order - b.stage.order || a.stage.name.localeCompare(b.stage.name) || a.id.localeCompare(b.id));
}

registerRevisionCarry("construction.members", (from, to, changedIds) => {
  const index = cache.get(from);
  if (!index || cache.has(to)) return;
  const b = new Builder(index);
  for (const id of changedIds) {
    const before = from[id];
    const after = to[id];
    if (before === after) continue;
    if (before) b.apply(before, -1);
    if (after) b.apply(after, 1);
  }
  cache.set(to, b.done());
});
