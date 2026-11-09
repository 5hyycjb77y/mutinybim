import { blockFreshness, renderModelBlock, type BlockSnapshot, type BlockTableInput, type ElementId, type FieldBlockSpec, type ModelState, type RenderedBlock } from "@permitzip/bim-kernel";
import { blockFreshnessLabel, blockStatuses, blockValueHash, sheetBlockValues } from "@permitzip/bim-sheets";
import type { IssuedCopy, ModelBlockReport, ModelBlockRequest, SheetBlockReport } from "@permitzip/bim-editor/contracts/bim/block-reports";

export type { IssuedCopy, ModelBlockReport, ModelBlockRequest, SheetBlockReport } from "@permitzip/bim-editor/contracts/bim/block-reports";

/**
 * Issue snapshots of live sheet blocks: what each load summary said when a
 * set was issued, so the issued copy never changes and the live sheet can say
 * "Changed since SD issue". A host keeps the rows write-once; this module is
 * the contract, an in-memory store, and the reports read against it.
 */

export interface IssueRef {
  readonly projectId: string;
  readonly modelId: string;
  readonly issueId: string;
  /** The issue as people name it ("SD", "Issued for permit"): the chip says "Matches SD issue". */
  readonly issueName: string;
}

export type IssueBlockSnapshot = BlockSnapshot & { readonly sheetId: ElementId };

export interface IssuedBlock {
  readonly blockId: string;
  readonly issueId: string;
  readonly issueName: string;
  readonly modelRevision: number;
  readonly valueHash: string;
  readonly rendered: RenderedBlock;
  readonly issuedAt: string;
}

export interface BlockSnapshotStore {
  /** Store one row per block for this issue. A retried issue finds its rows and stores nothing new; a different value under the same issue throws. */
  record(issue: IssueRef, snapshots: readonly IssueBlockSnapshot[]): Promise<{ readonly recorded: number; readonly existing: number }>;
  /** The newest issue snapshot of each block, by block id. */
  latest(projectId: string, modelId: string, blockIds: readonly string[]): Promise<ReadonlyMap<string, IssuedBlock>>;
  /** Every issue snapshot of these blocks, newest first (a report pins a block to one issue by name). */
  history(projectId: string, modelId: string, blockIds: readonly string[]): Promise<readonly IssuedBlock[]>;
}

/** Throws when an issue already froze one of these blocks with a different value. */
export function sameIssueBlockValues(issue: IssueRef, existing: ReadonlyMap<string, string>, snapshots: readonly IssueBlockSnapshot[]): void {
  for (const s of snapshots) {
    const hash = existing.get(s.blockId);
    if (hash && hash !== s.valueHash) throw new Error(`Issue "${issue.issueName}" already froze block ${s.blockId} with a different value. The issue can't be recorded twice with different text; issue it again under a new name.`);
  }
}

/** The same contract in memory, for tests and a local server. */
export function memoryBlockSnapshotStore(): BlockSnapshotStore & { readonly rows: ReadonlyArray<IssueRef & IssueBlockSnapshot & { readonly issuedAt: string }> } {
  const rows: Array<IssueRef & IssueBlockSnapshot & { readonly issuedAt: string }> = [];
  let clock = 0;
  return {
    rows,
    async record(issue, snapshots) {
      const stored = new Map(rows.filter((r) => r.issueId === issue.issueId).map((r) => [r.blockId as string, r.valueHash]));
      sameIssueBlockValues(issue, stored, snapshots);
      const missing = snapshots.filter((s) => !stored.has(s.blockId));
      for (const s of missing) rows.push({ ...issue, ...s, issuedAt: new Date(Date.UTC(2026, 9, 27, 0, 0, clock++)).toISOString() });
      return { recorded: missing.length, existing: snapshots.length - missing.length };
    },
    async latest(projectId, modelId, blockIds) {
      const out = new Map<string, IssuedBlock>();
      for (const r of rows) {
        if (r.projectId !== projectId || r.modelId !== modelId || !blockIds.includes(r.blockId)) continue;
        const prev = out.get(r.blockId);
        if (!prev || prev.issuedAt <= r.issuedAt) out.set(r.blockId, { blockId: r.blockId, issueId: r.issueId, issueName: r.issueName, modelRevision: r.modelRevision, valueHash: r.valueHash, rendered: r.rendered, issuedAt: r.issuedAt });
      }
      return out;
    },
    async history(projectId, modelId, blockIds) {
      return rows
        .filter((r) => r.projectId === projectId && r.modelId === modelId && blockIds.includes(r.blockId))
        .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : a.issuedAt > b.issuedAt ? -1 : 0))
        .map((r) => ({ blockId: r.blockId, issueId: r.issueId, issueName: r.issueName, modelRevision: r.modelRevision, valueHash: r.valueHash, rendered: r.rendered, issuedAt: r.issuedAt }));
    },
  };
}

/** Each live block on the sheets against its latest issue snapshot. */
export async function sheetBlockReport(model: ModelState, sheetIds: readonly string[], store: BlockSnapshotStore, projectId: string, modelId: string): Promise<SheetBlockReport[]> {
  const live = sheetBlockValues(model, sheetIds);
  const latest = await store.latest(projectId, modelId, live.map((v) => v.blockId));
  const labelled = new Map([...latest].map(([id, s]) => [id, { valueHash: s.valueHash, issueLabel: s.issueName, rendered: s.rendered }]));
  return blockStatuses(live, labelled).map((s) => {
    const issued = latest.get(s.blockId);
    return {
      sheetId: s.sheetId,
      blockId: s.blockId,
      title: s.title,
      freshness: s.freshness,
      label: blockFreshnessLabel(s.freshness),
      text: s.rendered.text,
      unresolved: s.rendered.unresolved,
      issuedText: s.issuedText,
      issuedAt: issued?.issuedAt ?? null,
      issuedAtRevision: issued?.modelRevision ?? null,
    };
  });
}

function copyOf(s: IssuedBlock): IssuedCopy {
  return { issueName: s.issueName, text: s.rendered.text, issuedAt: s.issuedAt, modelRevision: s.modelRevision };
}

function tableInput(spec: FieldBlockSpec): BlockTableInput | null {
  const t = spec.table;
  if (!t) return null;
  if (t.kind === "keynotes") return { kind: "keynotes", sheetId: t.sheetId, table: { ...t.table, keynotes: t.table.keynotes.map((k) => ({ ...k })) } };
  const scope = t.scope.kind === "model" ? { kind: "model" as const } : t.scope.kind === "level" ? { kind: "level" as const, levelId: t.scope.levelId } : { kind: "zone" as const, zoneId: t.scope.zoneId };
  return { kind: t.kind, scope };
}

export const MODEL_BLOCK_GONE = "This block is no longer in the building model. Someone may have removed it from its sheet; insert it again from Insert › Model block.";

/**
 * Blocks a report embeds, by id: the one definition rendered now (the same
 * text the sheet draws), its freshness against the latest issue, and, when
 * the report pins it to an issue, the copy frozen then. One snapshot read for
 * every block, through the store the caller was given.
 */
export async function modelBlockReport(model: ModelState, requests: readonly ModelBlockRequest[], store: BlockSnapshotStore, projectId: string, modelId: string): Promise<ModelBlockReport[]> {
  const found = requests.map((r) => ({ r, live: renderModelBlock(model, r.blockId) }));
  const ids = [...new Set(found.flatMap((f) => (f.live ? [f.live.blockId] : [])))];
  const history = await store.history(projectId, modelId, ids);
  return found.map(({ r, live }): ModelBlockReport => {
    if (!live) return { ok: false, blockId: r.blockId, message: MODEL_BLOCK_GONE };
    const mine = history.filter((h) => h.blockId === live.blockId);
    const latest = mine[0] ?? null;
    const valueHash = blockValueHash(live.rendered);
    const freshness = blockFreshness(valueHash, latest, latest?.issueName ?? "");
    const pinnedRow = r.pin ? (mine.find((h) => h.issueName === r.pin) ?? null) : null;
    return {
      ok: true,
      blockId: live.blockId,
      kind: live.kind,
      title: live.title,
      sheetId: live.sheetId,
      sheetNumber: live.sheetNumber,
      sheetName: live.sheetName,
      spec: { template: live.spec.template, title: live.spec.title ?? null, subjectId: live.spec.subjectId ?? null, table: tableInput(live.spec) },
      text: live.rendered.text,
      unresolved: live.rendered.unresolved,
      freshness,
      label: blockFreshnessLabel(freshness),
      latest: latest ? copyOf(latest) : null,
      issues: [...new Set(mine.map((h) => h.issueName))],
      pin: r.pin,
      pinned: pinnedRow ? copyOf(pinnedRow) : null,
      pinMissing: r.pin && !pinnedRow ? `This block wasn't on a set issued as "${r.pin}", so it shows live. Pick an issue it was frozen in, or show it live.` : null,
    };
  });
}
