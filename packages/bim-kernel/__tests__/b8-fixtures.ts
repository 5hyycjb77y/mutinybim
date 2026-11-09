import { asConnectionId, asElementId, asRevision, type Actor, type BimElement, type Changeset, type Connection, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const actor: Actor = { id: "user-b8", name: "B8", kind: "human" };

/** Small deterministic PRNG (mulberry32) so a failure reproduces. */
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

export interface History {
  readonly head: ModelState;
  /** Model at every revision, index = revision. */
  readonly snapshots: readonly ModelState[];
  readonly changesets: readonly Changeset[];
}

/**
 * `edits` random changesets on the demo model: rewrites, additions with a
 * connection, removals that cut their connections. Built directly (not through
 * commands) so the history reads are tested alone, with every intermediate
 * model kept as a plain rebuild.
 */
export function randomHistory(edits: number, seed = 8, modelId = "b8-main"): History {
  const next = rng(seed);
  const demo = createDemoModel(modelId);
  let elements: Record<string, BimElement> = { ...demo.elements };
  let connections: readonly Connection[] = demo.connections;
  const added: string[] = [];
  const snapshots: ModelState[] = [];
  const at = (revision: number): ModelState => ({ ...demo, revision: asRevision(revision), elements: { ...elements }, connections });
  snapshots[demo.revision] = at(demo.revision);
  const changesets: Changeset[] = [];
  let revision: number = demo.revision;
  for (let i = 0; i < edits; i++) {
    revision += 1;
    const pick = next();
    const ids = Object.keys(elements);
    const written: BimElement[] = [];
    const removedIds: string[] = [];
    const before: Record<string, BimElement | null> = {};
    let addedConnections: Connection[] = [];
    let removedConnections: Connection[] = [];
    if (pick < 0.55 || (added.length === 0 && pick >= 0.8)) {
      for (const id of ids.filter(() => next() < 0.25).slice(0, 3)) {
        const el = elements[id];
        if (!el) continue;
        before[id] = el;
        written.push({ ...el, version: el.version + 1 });
      }
    } else if (pick < 0.8) {
      const source = elements[ids[Math.floor(next() * ids.length)] ?? ""];
      if (source) {
        const id = asElementId(`b8-n${i}`);
        before[id] = null;
        written.push({ ...source, id, version: 1 });
        const partner = added[Math.floor(next() * added.length)];
        if (partner) addedConnections = [{ id: asConnectionId(`b8-c${i}`), a: { elementId: id, end: "start" }, b: { elementId: asElementId(partner), end: "end" } }];
        added.push(id);
      }
    } else {
      const id = added.splice(Math.floor(next() * added.length), 1)[0];
      const el = id ? elements[id] : undefined;
      if (id && el) {
        before[id] = el;
        removedIds.push(id);
        removedConnections = connections.filter((c) => c.a.elementId === id || c.b.elementId === id);
      }
    }
    const next_ = { ...elements };
    for (const id of removedIds) delete next_[id];
    for (const el of written) next_[el.id] = el;
    elements = next_;
    const cut = new Set(removedConnections.map((c) => c.id));
    connections = [...connections.filter((c) => !cut.has(c.id)), ...addedConnections];
    changesets.push({
      revision: asRevision(revision),
      baseRevision: revision - 1,
      idempotencyKey: `b8-${seed}-${i}`,
      actor,
      command: { type: "set_tag_text", tagId: "b8", text: "b8" },
      elements: written,
      readSet: {},
      authored: [],
      intents: [],
      rebased: false,
      committedAt: new Date(0).toISOString(),
      ...(removedIds.length > 0 ? { removedIds: removedIds.map(asElementId) } : {}),
      before,
      ...(addedConnections.length > 0 ? { addedConnections } : {}),
      ...(removedConnections.length > 0 ? { removedConnections } : {}),
    });
    snapshots[revision] = at(revision);
  }
  return { head: at(revision), snapshots, changesets };
}
