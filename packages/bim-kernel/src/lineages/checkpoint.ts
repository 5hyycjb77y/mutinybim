import { canonicalize, sha256HexOf } from "../authorship/canonical";
import type { ModelState } from "../types";
import type { LineageCheckpoint } from "./types";

/**
 * Checkpoints (D1): a lineage's state at a revision, named by a digest, so a
 * decades-long copy opens from its last checkpoint and replays only the
 * changesets after it (`replayTo`). Shape and digest here; storage and when
 * to write one are the model server's (W11), off the commit path.
 */

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The digest of a state: every record (by id, sorted) and every connection
 * (by id, sorted), each hashed over its canonical bytes, then hashed together
 * with the revision. Reads the whole state once: for checkpoints and bundle
 * anchors only, never on an edit.
 */
export function lineageStateDigest(state: Pick<ModelState, "revision" | "elements" | "connections">): string {
  const ids = Object.keys(state.elements).sort(); // full-scan-ok: a checkpoint digests the whole state, off the edit path
  const records = ids.map((id) => [id, sha256HexOf(canonicalize(state.elements[id]))]);
  const connections = [...state.connections].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, sha256HexOf(canonicalize(c))]);
  return sha256HexOf(canonicalize({ v: 1, revision: state.revision, records, connections }));
}

export function lineageCheckpoint(lineageId: string, state: Pick<ModelState, "revision" | "elements" | "connections">): LineageCheckpoint {
  return { lineageId, revision: state.revision, stateDigest: lineageStateDigest(state) };
}

export type CheckpointRead = { readonly ok: true; readonly value: LineageCheckpoint } | { readonly ok: false; readonly reason: string };

/** A stored checkpoint (camelCase or the host's snake_case). */
export function readLineageCheckpoint(raw: unknown): CheckpointRead {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "a checkpoint must be an object" };
  const r = raw as Readonly<Record<string, unknown>>;
  const lineageId = r.lineageId ?? r.lineage_id;
  const revision = r.revision;
  const stateDigest = r.stateDigest ?? r.state_digest;
  if (typeof lineageId !== "string" || lineageId.length === 0) return { ok: false, reason: "a checkpoint names its copy" };
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return { ok: false, reason: "a checkpoint names a whole revision" };
  if (typeof stateDigest !== "string" || !HEX64.test(stateDigest)) return { ok: false, reason: "a checkpoint's state digest is 64 lower-case hex digits" };
  return { ok: true, value: { lineageId, revision, stateDigest } };
}
