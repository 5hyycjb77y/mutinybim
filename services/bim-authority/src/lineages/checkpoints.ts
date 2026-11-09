import { type BimElement, type Changeset, type Connection, type ModelState } from "@permitzip/bim-kernel";
import { readLineageCheckpoint } from "@permitzip/bim-kernel/lineages";
import { LINEAGE_CHECKPOINT_EVERY, lineageCheckpointBody, type LineageCheckpointBody, type LineageCheckpointStore } from "@permitzip/bim-sync/lineages";
import type postgres from "postgres";
import type { Sql } from "../pg-store";

type JsonValue = Parameters<Sql["json"]>[0];

/** A chunk as plain JSON (no class instances, no undefined), as the store writes every body. */
function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

type Tx = postgres.TransactionSql;

/**
 * Copy checkpoints on the model server's database (round 11 W11):
 * db/migrations/20261103100100_bim_lineage_checkpoints.sql. A checkpoint
 * row names the copy, its revision, its fork pin and the state digest; the
 * net change rides in chunks (`bim.lineage_checkpoint_chunks`) so no row
 * holds a whole 100k-record delta. Written off the commit path; read once
 * per open. The newest three per copy are kept.
 */

/** Records per chunk row. */
export const CHECKPOINT_CHUNK_RECORDS = 5000;
const KEEP_NEWEST = 3;

interface ChunkBody {
  readonly elements?: readonly BimElement[];
  readonly removedIds?: readonly string[];
  readonly addedConnections?: readonly Connection[];
  readonly removedConnections?: readonly Connection[];
}

export function checkpointChunks(body: LineageCheckpointBody): ChunkBody[] {
  const chunks: ChunkBody[] = [];
  for (let i = 0; i < body.elements.length; i += CHECKPOINT_CHUNK_RECORDS) chunks.push({ elements: body.elements.slice(i, i + CHECKPOINT_CHUNK_RECORDS) });
  chunks.push({ removedIds: body.removedIds, addedConnections: body.addedConnections, removedConnections: body.removedConnections });
  return chunks;
}

function isChunkBody(v: unknown): v is ChunkBody {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class PgLineageCheckpointStore implements LineageCheckpointStore {
  private hasTable: Promise<boolean> | null = null;

  constructor(private readonly sql: Sql | Tx) {}

  private stored(): Promise<boolean> {
    const known = this.hasTable;
    if (known) return known;
    const asked = this.sql<{ ok: boolean }[]>`select to_regclass('bim.lineage_checkpoints') is not null as ok`.then(
      (rows: readonly { ok: boolean }[]) => rows[0]?.ok === true,
      (err: unknown) => {
        this.hasTable = null;
        throw err;
      },
    );
    this.hasTable = asked;
    return asked;
  }

  async latest(modelId: string, atMost: number): Promise<LineageCheckpointBody | null> {
    if (!(await this.stored())) return null;
    const [head] = await this.sql<{ revision: string; fork_revision: string; state_digest: string; chunk_count: number }[]>`
      select revision::text, fork_revision::text, state_digest, chunk_count from bim.lineage_checkpoints
      where model_id = ${modelId} and revision <= ${atMost} order by revision desc limit 1`; // the newest one only
    if (!head) return null;
    const read = readLineageCheckpoint({ lineageId: modelId, revision: Number(head.revision), stateDigest: head.state_digest });
    if (!read.ok) {
      console.error("[bim-authority] a copy checkpoint can't be read; the copy replays from its fork instead", { modelId, reason: read.reason });
      return null;
    }
    const chunks = await this.sql<{ chunk: number; body: unknown }[]>`
      select chunk, body from bim.lineage_checkpoint_chunks where model_id = ${modelId} and revision = ${head.revision} order by chunk`;
    if (chunks.length !== head.chunk_count) {
      console.error("[bim-authority] a copy checkpoint is missing chunks; the copy replays from its fork instead", { modelId, revision: head.revision, expected: head.chunk_count, found: chunks.length });
      return null;
    }
    const elements: BimElement[] = [];
    const removedIds: string[] = [];
    const addedConnections: Connection[] = [];
    const removedConnections: Connection[] = [];
    for (const { body } of chunks) {
      if (!isChunkBody(body)) {
        console.error("[bim-authority] a copy checkpoint chunk isn't an object; the copy replays from its fork instead", { modelId, revision: head.revision });
        return null;
      }
      elements.push(...(body.elements ?? []));
      removedIds.push(...(body.removedIds ?? []));
      addedConnections.push(...(body.addedConnections ?? []));
      removedConnections.push(...(body.removedConnections ?? []));
    }
    return { checkpoint: { ...read.value, lineageId: modelId }, forkRevision: Number(head.fork_revision), elements, removedIds, addedConnections, removedConnections };
  }

  async write(modelId: string, body: LineageCheckpointBody): Promise<void> {
    if (!(await this.stored())) return;
    const chunks = checkpointChunks(body);
    const sql = this.sql;
    const run = async (tx: Sql | Tx) => {
      const written = await tx`
        insert into bim.lineage_checkpoints (model_id, revision, fork_revision, state_digest, element_count, chunk_count)
        select ${modelId}, ${body.checkpoint.revision}, ${body.forkRevision}, ${body.checkpoint.stateDigest}, ${body.elements.length}, ${chunks.length}
        from bim.models m where m.id = ${modelId} and m.revision >= ${body.checkpoint.revision}
        on conflict (model_id, revision) do nothing
        returning 1`;
      if (written.length !== 1) return;
      for (let i = 0; i < chunks.length; i++) {
        await tx`insert into bim.lineage_checkpoint_chunks (model_id, revision, chunk, body) values (${modelId}, ${body.checkpoint.revision}, ${i}, ${tx.json(asJson(chunks[i]))})`;
      }
      await tx`
        delete from bim.lineage_checkpoints k where k.model_id = ${modelId} and k.revision < (
          select min(r.revision) from (select k2.revision from bim.lineage_checkpoints k2 where k2.model_id = ${modelId} order by k2.revision desc limit ${KEEP_NEWEST}) r
        )`;
    };
    if ("begin" in sql) await sql.begin((tx: Tx) => run(tx));
    else await run(sql);
  }
}

/**
 * Writes a copy's checkpoint every LINEAGE_CHECKPOINT_EVERY own revisions,
 * after they are durable (never on the commit path). One in flight per copy;
 * a failure is logged and tried again at the next interval.
 */
export function lineageCheckpointer(input: {
  readonly store: LineageCheckpointStore;
  readonly modelId: string;
  readonly lineageId: string;
  readonly forkRevision: number;
  readonly head: () => Promise<ModelState>;
  readonly ownChanges: (since: number) => Promise<readonly Changeset[]>;
  readonly every?: number;
}): (revision: number) => void {
  let last = input.forkRevision;
  let writing: Promise<void> | null = null;
  return (revision) => {
    if (writing || revision - last < (input.every ?? LINEAGE_CHECKPOINT_EVERY)) return;
    writing = (async () => {
      const head = await input.head();
      await input.store.write(input.modelId, lineageCheckpointBody(input.lineageId, input.forkRevision, head, await input.ownChanges(input.forkRevision)));
      last = head.revision;
      console.log("[bim-authority] copy checkpoint written", { modelId: input.modelId, revision: head.revision });
    })()
      .catch((err) => console.error("[bim-authority] copy checkpoint failed; will try again at the next interval", { modelId: input.modelId, revision, err }))
      .finally(() => {
        writing = null;
      });
  };
}
