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

/** Whether a record is joined to anything: the common case is that it isn't, and this allocates nothing to say so. */
function isJoined(r: BimElement): boolean {
  if (r.kind === "run_segment") return r.links.start !== undefined || r.links.end !== undefined || r.branches.length > 0;
  if (r.kind === "run_fitting") return r.host !== undefined || r.ports.some((p) => p.link !== undefined);
  if (r.kind === "part") return r.links !== undefined && Object.keys(r.links).length > 0;
  return false;
}

/** The records a record is joined to: its links, the fittings on it and the run it sits on. Each side of a join names the other. */
function joinedIds(r: BimElement): ElementId[] {
  if (r.kind === "run_segment") return [...(r.links.start ? [r.links.start.elementId] : []), ...(r.links.end ? [r.links.end.elementId] : []), ...r.branches];
  if (r.kind === "run_fitting") return [...r.ports.flatMap((p) => (p.link ? [p.link.elementId] : [])), ...(r.host ? [r.host.segmentId] : [])];
  if (r.kind === "part") return r.links ? Object.values(r.links).map((link) => link.elementId) : [];
  return [];
}

/**
 * The plan's records in the chunks they land in, order kept (levels and
 * shared types before what uses them). Records joined to each other land in
 * one chunk, at the place of the last of them: a join is two records naming
 * each other and a chunk is checked as it lands, so a chunk holding one side
 * alone would be refused, and no revision is left with a half-made join.
 * Joined records that outnumber `size` land whole, as one chunk over size.
 */
export function importChunks(records: readonly BimElement[], size: number = IMPORT_CHUNK_SIZE): BimElement[][] {
  const out: BimElement[][] = [];
  if (!records.some(isJoined)) {
    for (let i = 0; i < records.length; i += size) out.push(records.slice(i, i + size));
    return out;
  }
  // Joined records grouped (union-find over the joins, each group kept under its last record); one joined to nothing is a group of one.
  const at = new Map<ElementId, number>();
  records.forEach((r, i) => at.set(r.id, i));
  const parent = new Int32Array(records.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const root = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    // Point everything on the way straight at the root, so the next walk is one step.
    for (let walk = i; walk !== r; ) {
      const next = parent[walk] ?? r;
      parent[walk] = r;
      walk = next;
    }
    return r;
  };
  records.forEach((r, i) => {
    if (!isJoined(r)) return;
    for (const id of joinedIds(r)) {
      const j = at.get(id);
      if (j === undefined) continue;
      const a = root(i);
      const b = root(j);
      if (a !== b) parent[Math.min(a, b)] = Math.max(a, b);
    }
  });
  const groups = new Map<number, BimElement[]>();
  records.forEach((r, i) => {
    const g = root(i);
    const members = groups.get(g);
    if (members) members.push(r);
    else groups.set(g, [r]);
  });
  let chunk: BimElement[] = [];
  for (let i = 0; i < records.length; i++) {
    // A group comes out where its last record was, so whatever any of its records uses is in this chunk or an earlier one.
    const group = groups.get(i);
    if (!group) continue;
    if (chunk.length > 0 && chunk.length + group.length > size) {
      out.push(chunk);
      chunk = [];
    }
    for (const r of group) chunk.push(r);
    if (chunk.length >= size) {
      out.push(chunk);
      chunk = [];
    }
  }
  if (chunk.length > 0) out.push(chunk);
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
  const droppedIds = new Set<ElementId>();
  for (const chunk of importChunks(records, opts.size)) {
    let pending = withoutDropped(chunk, droppedIds);
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
      for (const id of named) {
        if (droppedIds.has(id) || !pending.some((r) => r.id === id)) continue;
        droppedIds.add(id);
        dropped.push({ id, reason: result.error.message });
      }
      pending = withoutDropped(pending, droppedIds);
    }
  }
  return { model: current, revisions, dropped };
}

/** The records a record can't be in the model without: its host, its type, its system, its level. */
function neededIds(r: BimElement): ElementId[] {
  if (r.kind === "opening") return [r.hostId];
  if (r.kind === "run_segment") return [r.systemId, r.levelId];
  if (r.kind === "run_fitting") return [r.systemId, r.levelId, ...(r.host ? [r.host.segmentId] : [])];
  if (r.kind === "part") return [r.typeId, r.levelId];
  return [];
}

/** Whether a record can't land without a dropped one (a door in a dropped wall, a branch fitting on a dropped run). */
export function usesDropped(r: BimElement, id: ElementId): boolean {
  return neededIds(r).includes(id);
}

/** A record with its joins to records that are gone taken off: its end, opening or connector there is open. */
function unjoined(r: BimElement, gone: ReadonlySet<ElementId>): BimElement {
  if (!isJoined(r) || !joinedIds(r).some((id) => gone.has(id))) return r;
  if (r.kind === "run_segment") {
    const { start, end } = r.links;
    return { ...r, links: { ...(start && !gone.has(start.elementId) ? { start } : {}), ...(end && !gone.has(end.elementId) ? { end } : {}) }, branches: r.branches.filter((id) => !gone.has(id)) };
  }
  if (r.kind === "run_fitting") {
    return { ...r, ports: r.ports.map((p) => (p.link && gone.has(p.link.elementId) ? { id: p.id, position: p.position, direction: p.direction, size: p.size } : p)) };
  }
  if (r.kind === "part" && r.links) {
    const { links, ...rest } = r;
    const kept = Object.fromEntries(Object.entries(links).filter(([, link]) => !gone.has(link.elementId)));
    return Object.keys(kept).length > 0 ? { ...rest, links: kept } : rest;
  }
  return r;
}

/**
 * What is left of a chunk once some records are dropped: without them, without
 * whatever can't land without them (a door in a dropped wall), and with every
 * join to one of those taken off the record that stays, so nothing is left
 * naming a record that isn't there.
 */
export function withoutDropped(records: readonly BimElement[], dropped: ReadonlySet<ElementId>): BimElement[] {
  if (dropped.size === 0) return [...records];
  const gone = new Set(dropped);
  let kept = records.filter((r) => !gone.has(r.id));
  for (;;) {
    const next = kept.filter((r) => {
      if (!neededIds(r).some((id) => gone.has(id))) return true;
      gone.add(r.id);
      return false;
    });
    if (next.length === kept.length) break;
    kept = next;
  }
  return kept.map((r) => unjoined(r, gone));
}
