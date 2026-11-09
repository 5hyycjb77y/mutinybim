import { finish, type ExecuteResult } from "../command-core";
import { TrackedReader } from "../model";
import { draftElements } from "../store";
import type { BimElement, ElementId, ModelState } from "../types";

/**
 * Landing an import on a branch (round 9 I9). The model server applies a
 * plan in chunks through the server-only `import_elements` command, the
 * records supplied as the command's context from the server's own
 * conversion, never from a client. An import only adds: a record whose id is
 * already in the model, or one without `provenance`, refuses the chunk.
 */

/** Peers (model servers) that apply an IFC import on a new branch. A client never sends `import_elements`. */
export const BRANCHES_IMPORT_FEATURE = "branches:import";

/** What a client hears if it sends `import_elements` itself. */
export const IMPORT_SERVER_ONLY_REFUSAL = "A linked model opens as a branch only through Propose changes to this model (Building Model › Linked models). Nothing changed.";

/** Records per `import_elements` revision: the size `merge.apply.2k_changed` is budgeted at. */
export const IMPORT_CHUNK_SIZE = 2000;

export interface ImportLanding {
  readonly records: readonly BimElement[];
}

function provenanceOf(el: BimElement): unknown {
  return Reflect.get(el, "provenance");
}

/** Add one chunk of imported records as one revision. */
export function landImportChunk(model: ModelState, records: readonly BimElement[]): ExecuteResult {
  const reader = new TrackedReader(model);
  const working = draftElements(model.elements);
  const touched: ElementId[] = [];
  for (const r of records) {
    if (reader.find(r.id) || working[r.id] !== model.elements[r.id]) {
      return { ok: false, error: { code: "already_exists", message: `${r.id} is already in this model; an import only adds. Nothing changed.`, elementIds: [r.id] } };
    }
    if (r.kind !== "part_type" && r.kind !== "level" && typeof provenanceOf(r) !== "object") {
      return { ok: false, error: { code: "invalid_value", message: `${r.id} doesn't say which linked model it came from. Nothing changed.`, elementIds: [r.id] } };
    }
    working[r.id] = r;
    touched.push(r.id);
  }
  if (touched.length === 0) return { ok: false, error: { code: "invalid_value", message: "Nothing to import in this part of the model. Nothing changed.", elementIds: [] } };
  return finish(reader, working, touched, [], () => []);
}

/** The plan's records in the chunks they land in, order kept (levels and shared types before what uses them). */
export function importChunks(records: readonly BimElement[], size: number = IMPORT_CHUNK_SIZE): BimElement[][] {
  const out: BimElement[][] = [];
  for (let i = 0; i < records.length; i += size) out.push(records.slice(i, i + size));
  return out;
}

export interface LandedImport {
  readonly model: ModelState;
  readonly revisions: number;
  /** Records a chunk refused (an issue the model won't accept), dropped so the rest lands; each stays on the linked model. */
  readonly dropped: readonly { readonly id: ElementId; readonly reason: string }[];
}

/**
 * Land every chunk on `model` in memory (tests, drills and the perf row; the
 * model server does the same through its sequencer). A chunk refused for
 * named records lands without them, up to `retries` times.
 */
export function landImport(model: ModelState, records: readonly BimElement[], opts: { readonly size?: number; readonly retries?: number } = {}): LandedImport {
  let current = model;
  let revisions = 0;
  const dropped: Array<{ id: ElementId; reason: string }> = [];
  for (const chunk of importChunks(records, opts.size)) {
    let pending = chunk.filter((r) => !dropped.some((d) => usesDropped(r, d.id)));
    for (let attempt = 0; attempt <= (opts.retries ?? 3) && pending.length > 0; attempt++) {
      const result = landImportChunk(current, pending);
      if (result.ok) {
        current = result.model;
        revisions += 1;
        pending = [];
        break;
      }
      const named = new Set(result.error.elementIds);
      if (named.size === 0 || ![...named].some((id) => pending.some((r) => r.id === id))) throw new Error(`[bim-kernel/import] a chunk was refused: ${result.error.message}`);
      for (const id of named) if (pending.some((r) => r.id === id) && !dropped.some((d) => d.id === id)) dropped.push({ id, reason: result.error.message });
      pending = pending.filter((r) => !named.has(r.id) && !dropped.some((d) => usesDropped(r, d.id)));
    }
  }
  return { model: current, revisions, dropped };
}

/** Whether a record points at a dropped one (a door in a dropped wall). */
export function usesDropped(r: BimElement, id: ElementId): boolean {
  if (r.kind === "opening") return r.hostId === id;
  if (r.kind === "run_segment") return r.systemId === id || r.levelId === id;
  if (r.kind === "part") return r.typeId === id || r.levelId === id;
  return false;
}
