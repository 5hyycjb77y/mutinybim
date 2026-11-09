/**
 * Round 8b lane O fixtures: a history of changesets over round 7's three
 * offices (walls with doors, one wall type), every intermediate model kept
 * as a plain rebuild, so a delta from sparse history reads can be compared
 * with a delta over the full models.
 */
import { asElementId, asRevision, type Actor, type BimElement, type Changeset, type ModelState } from "../src";
import { FT, openingRecord, typeRecord, wallRecord } from "./q7-fixtures";

const actor: Actor = { id: "user-o8", name: "O8", kind: "human" };

export interface Step {
  readonly written?: readonly BimElement[];
  readonly removedIds?: readonly string[];
}

export interface History {
  readonly head: ModelState;
  readonly snapshots: readonly ModelState[];
  readonly changesets: readonly Changeset[];
}

/** Applies `steps` to `base`, one changeset each. */
export function historyOf(base: ModelState, steps: readonly Step[], key = "o8"): History {
  let elements: Record<string, BimElement> = { ...base.elements };
  const snapshots: ModelState[] = [];
  const at = (revision: number): ModelState => ({ ...base, revision: asRevision(revision), elements: { ...elements } });
  snapshots[base.revision] = at(base.revision);
  const changesets: Changeset[] = [];
  let revision: number = base.revision;
  steps.forEach((step, i) => {
    revision += 1;
    const before: Record<string, BimElement | null> = {};
    const next = { ...elements };
    for (const id of step.removedIds ?? []) {
      before[id] = elements[id] ?? null;
      delete next[id];
    }
    const written = (step.written ?? []).map((el) => {
      const prior = elements[el.id];
      before[el.id] = prior ?? null;
      return { ...el, version: (prior?.version ?? 0) + 1 };
    });
    for (const el of written) next[el.id] = el;
    elements = next;
    changesets.push({
      revision: asRevision(revision),
      baseRevision: revision - 1,
      idempotencyKey: `${key}-${i}`,
      actor,
      command: { type: "set_tag_text", tagId: "o8", text: "o8" },
      elements: written,
      readSet: {},
      authored: [],
      intents: [],
      rebased: false,
      committedAt: new Date(0).toISOString(),
      ...((step.removedIds ?? []).length > 0 ? { removedIds: (step.removedIds ?? []).map(asElementId) } : {}),
      before,
    });
    snapshots[revision] = at(revision);
  });
  return { head: at(revision), snapshots, changesets };
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` random edits on the three offices: lengthen or shorten a wall, add a
 * wall (sometimes with a door), add or remove a door, re-type a wall.
 */
export function randomOfficeSteps(base: ModelState, n: number, seed = 8): Step[] {
  const next = rng(seed);
  let elements: Record<string, BimElement> = { ...base.elements };
  const steps: Step[] = [];
  const walls = () => Object.values(elements).filter((e) => e.kind === "wall");
  const doors = () => Object.values(elements).filter((e) => e.kind === "opening");
  for (let i = 0; i < n; i++) {
    const pick = next();
    let step: Step = {};
    const ws = walls();
    const w = ws[Math.floor(next() * ws.length)];
    if (pick < 0.3 && w && "start" in w && "end" in w) {
      const end = w.end as { x: number; y: number };
      step = { written: [{ ...w, end: { x: end.x, y: end.y + Math.round((next() * 6 - 3) * FT) } } as BimElement] };
    } else if (pick < 0.5) {
      const id = `W-n${i}`;
      const wall = wallRecord(id, { x: 100 * FT + i * 10 * FT, y: 0 }, { x: 100 * FT + i * 10 * FT, y: (5 + Math.floor(next() * 20)) * FT }, { typeId: asElementId(next() < 0.5 ? "t-1hr" : "t-2hr") });
      step = { written: next() < 0.5 ? [wall, openingRecord(`D-n${i}`, id, "door", 3 * FT, 7 * FT)] : [wall] };
    } else if (pick < 0.7 && w) {
      step = { written: [openingRecord(`D-x${i}`, w.id, next() < 0.5 ? "door" : "window", 3 * FT, 4 * FT, 2 * FT)] };
    } else if (pick < 0.85) {
      const ds = doors();
      const d = ds[Math.floor(next() * ds.length)];
      step = d ? { removedIds: [d.id] } : {};
    } else if (w) {
      step = { written: [{ ...w, typeId: asElementId("t-2hr") } as BimElement] };
    }
    const nextEls = { ...elements };
    for (const id of step.removedIds ?? []) delete nextEls[id];
    for (const el of step.written ?? []) nextEls[el.id] = el;
    elements = nextEls;
    steps.push(step);
  }
  return steps;
}

/** The second wall type random steps use. */
export const TWO_HOUR_TYPE = typeRecord("t-2hr", "2-hour wall");
