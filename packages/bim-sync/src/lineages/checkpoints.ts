import {
  applyChangeset,
  asElementId,
  asRevision,
  changesetTouchedIds,
  type BimElement,
  type Changeset,
  type Connection,
  type ModelState,
} from "@permitzip/bim-kernel";
import {
  lineageStateDigest,
  netConnectionChanges,
  type LineageCheckpoint,
} from "@permitzip/bim-kernel/lineages";

/**
 * Lineage checkpoints (round 11 W11, D1): a copy that lives for decades opens
 * from its newest checkpoint, never by replaying every changeset since it was
 * made. A checkpoint holds the copy's **net change** from its fork pin to one
 * revision (the records it rewrote as they then stood, the ids it removed,
 * the connections it made and cut), not the whole state: a 10 % copy of a
 * 1M-record design stores 100k records, and its unchanged records stay
 * shared with the parent (copy on write).
 *
 * Opening: the parent's state at the pin (`forkState`, as round 8b) + the
 * checkpoint's net change in one step + only the copy's own changesets after
 * the checkpoint. Written off the commit path (the host schedules it).
 */

export interface LineageCheckpointBody {
  readonly checkpoint: LineageCheckpoint;
  /** The copy's fork pin on its parent's line (the checkpoint is relative to it). */
  readonly forkRevision: number;
  readonly elements: readonly BimElement[];
  readonly removedIds: readonly string[];
  readonly addedConnections: readonly Connection[];
  readonly removedConnections: readonly Connection[];
}

/** Write a checkpoint once a copy has this many own revisions past its last one (or its fork). */
export const LINEAGE_CHECKPOINT_EVERY = 500;

/**
 * The net change of a copy from `forkRevision` to `head.revision`, read from
 * its own changesets (ids they touched) and its head (each touched record as
 * it stands now). `stateDigest` is the kernel's digest of the whole head: it
 * reads every record once, so this runs off the commit path only.
 */
export function lineageCheckpointBody(lineageId: string, forkRevision: number, head: ModelState, own: readonly Changeset[]): LineageCheckpointBody {
  const touched = new Set<string>();
  for (const cs of own) if (cs.revision > forkRevision && cs.revision <= head.revision) for (const id of changesetTouchedIds(cs)) touched.add(id);
  const elements: BimElement[] = [];
  const removedIds: string[] = [];
  for (const id of [...touched].sort()) {
    const el = head.elements[id];
    if (el) elements.push(el);
    else removedIds.push(id);
  }
  const net = netConnectionChanges(own, forkRevision, head.revision);
  return {
    checkpoint: { lineageId, revision: head.revision, stateDigest: lineageStateDigest(head) },
    forkRevision,
    elements,
    removedIds,
    addedConnections: net.added,
    removedConnections: net.removed,
  };
}

export class LineageCheckpointMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineageCheckpointMismatch";
  }
}

export interface OpenedLineageHead {
  readonly model: ModelState;
  /** Own changesets applied one by one after the fork or the checkpoint (the replay a checkpoint saves). */
  readonly replayed: number;
  /** The checkpoint revision opened from (null: none, replayed from the fork). */
  readonly fromCheckpoint: number | null;
}

/**
 * A copy's head: `fork` (its parent's state at the pin, already under the
 * copy's model id) plus the checkpoint's net change (when one applies), plus
 * `after` (its own changesets after the checkpoint, or after the fork).
 * A checkpoint for another fork pin is refused, never guessed at.
 */
export function openLineageHead(input: { readonly fork: ModelState; readonly checkpoint: LineageCheckpointBody | null; readonly own: readonly Changeset[] }): OpenedLineageHead {
  let model = input.fork;
  let from: number = input.fork.revision;
  const cp = input.checkpoint;
  if (cp) {
    if (cp.forkRevision !== input.fork.revision) throw new LineageCheckpointMismatch(`The checkpoint of copy ${cp.checkpoint.lineageId} was made for version ${cp.forkRevision} of its parent, not ${input.fork.revision}.`);
    const step: Changeset = {
      revision: asRevision(model.revision + 1),
      baseRevision: model.revision,
      idempotencyKey: `checkpoint-${cp.checkpoint.lineageId}-${cp.checkpoint.revision}`,
      actor: { id: "checkpoint", name: "Checkpoint", kind: "agent" },
      command: { type: "set_tag_text", tagId: "checkpoint", text: "checkpoint" },
      elements: cp.elements,
      removedIds: cp.removedIds.map(asElementId),
      addedConnections: [...cp.addedConnections],
      removedConnections: [...cp.removedConnections],
      readSet: {},
      authored: [],
      intents: [],
      rebased: false,
      committedAt: new Date(0).toISOString(),
    };
    model = { ...applyChangeset(model, step), revision: asRevision(cp.checkpoint.revision) };
    from = cp.checkpoint.revision;
  }
  let replayed = 0;
  for (const cs of [...input.own].sort((a, b) => a.revision - b.revision)) {
    if (cs.revision <= from) continue;
    model = applyChangeset(model, cs);
    replayed += 1;
  }
  return { model, replayed, fromCheckpoint: cp ? cp.checkpoint.revision : null };
}

/** Whether a reopened head is the state the checkpoint named (drills and tests; reads the whole state). */
export function checkpointMatches(cp: LineageCheckpointBody, state: ModelState): boolean {
  return state.revision === cp.checkpoint.revision && lineageStateDigest(state) === cp.checkpoint.stateDigest;
}

/** Where a host keeps lineage checkpoints (model server: bim.lineage_checkpoints). */
export interface LineageCheckpointStore {
  /** The newest checkpoint of a copy at or below `atMost` (its head), or null. */
  latest(modelId: string, atMost: number): Promise<LineageCheckpointBody | null>;
  write(modelId: string, body: LineageCheckpointBody): Promise<void>;
}

export class InMemoryLineageCheckpointStore implements LineageCheckpointStore {
  private readonly byModel = new Map<string, LineageCheckpointBody[]>();

  async latest(modelId: string, atMost: number): Promise<LineageCheckpointBody | null> {
    const list = this.byModel.get(modelId) ?? [];
    let best: LineageCheckpointBody | null = null;
    for (const cp of list) if (cp.checkpoint.revision <= atMost && (!best || cp.checkpoint.revision > best.checkpoint.revision)) best = cp;
    return best;
  }

  async write(modelId: string, body: LineageCheckpointBody): Promise<void> {
    const list = (this.byModel.get(modelId) ?? []).filter((cp) => cp.checkpoint.revision !== body.checkpoint.revision);
    this.byModel.set(modelId, [...list, body]);
  }
}
