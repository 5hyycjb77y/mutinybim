import type {
  ActorRef,
  CellEditBatch,
  CellRef,
  CellValue,
  ColumnValues,
  EditingPresence,
  EditOutcome,
  EditPreview,
  RowPatch,
  RowSet,
  RowSetColumn,
  RowUpsert,
  ScheduleConnection,
  ScheduleEvent,
  ScheduleSubscription,
  ScheduleTarget,
} from "../contracts";
import { EDITING_CELL_MAX_TTL_MS } from "../contracts";

/**
 * In-memory stand-in for the schedule engine (Stream E) and the authority
 * subscription (Stream G), so the grid can be built and tested before they
 * land. It honours the same contract: whole rows on open, patches after
 * edits, type-scope previews, `editing_cell` presence with a TTL, and a
 * `denied` close when access is withdrawn. Not for production use.
 */

export interface MockRow {
  readonly key: string;
  readonly elementId: string;
  /** Type the row's part belongs to, for type-scope columns. */
  readonly typeId?: string;
  readonly values: Readonly<Record<string, CellValue>>;
  /** `expand` column id → child rows. */
  readonly children?: Readonly<Record<string, readonly MockRow[]>>;
}

export interface MockSchedule {
  readonly viewId: string;
  readonly columns: readonly RowSetColumn[];
  readonly rows: readonly MockRow[];
  /** Type id → label and how many parts in the whole model share it. */
  readonly types?: Readonly<Record<string, { readonly label: string; readonly instanceCount: number }>>;
  /** Recomputes locked (formula, aggregate) values after an edit. */
  readonly derive?: (row: MockRow) => Readonly<Record<string, CellValue>>;
  /** Explain text for a locked cell. */
  readonly explain?: (row: MockRow, columnId: string) => string | null;
  /** Server-side refusal, e.g. a mark that's already taken. */
  readonly validate?: (row: MockRow, columnId: string, value: CellValue) => string | null;
}

interface MutableRow {
  key: string;
  elementId: string;
  typeId?: string;
  values: Record<string, CellValue>;
  children?: Record<string, MutableRow[]>;
}

function toMutable(r: MockRow): MutableRow {
  return {
    key: r.key,
    elementId: r.elementId,
    ...(r.typeId ? { typeId: r.typeId } : {}),
    values: { ...r.values },
    ...(r.children ? { children: Object.fromEntries(Object.entries(r.children).map(([c, rows]) => [c, rows.map(toMutable)])) } : {}),
  };
}

function columnValues(column: RowSetColumn, rows: readonly MutableRow[]): ColumnValues {
  if (column.valueType === "quantity") {
    const v = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i]?.values[column.id];
      v[i] = typeof x === "number" ? x : NaN;
    }
    return { type: "quantity", kind: column.quantityKind ?? "dimensionless", values: v };
  }
  if (column.valueType === "boolean") {
    const v = new Int8Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i]?.values[column.id];
      v[i] = x === true ? 1 : x === false ? 0 : -1;
    }
    return { type: "boolean", values: v };
  }
  return { type: "text", values: rows.map((r) => (r.values[column.id] === null || r.values[column.id] === undefined ? null : String(r.values[column.id]))) };
}

function toRowSet(viewId: string, revision: number, columns: readonly RowSetColumn[], rows: readonly MutableRow[]): RowSet {
  const values = new Map<string, ColumnValues>();
  for (const c of columns) if (c.kind !== "expand") values.set(c.id, columnValues(c, rows));
  const children = new Map<string, Map<string, RowSet>>();
  for (const c of columns) {
    if (c.kind !== "expand" || !c.childColumns) continue;
    const byParent = new Map<string, RowSet>();
    for (const r of rows) {
      const kids = r.children?.[c.id];
      if (kids && kids.length > 0) byParent.set(r.key, toRowSet(viewId, revision, c.childColumns, kids));
    }
    children.set(c.id, byParent);
  }
  return { viewId, revision, columns, rowCount: rows.length, rowKeys: rows.map((r) => r.key), elementIds: rows.map((r) => r.elementId), values, children };
}

export interface MockScheduleConnection extends ScheduleConnection {
  /** Another person starts editing a cell (their `editing_cell`). */
  simulateEditing(actor: ActorRef, viewId: string, cell: CellRef, ttlMs?: number): void;
  simulateRelease(actor: ActorRef, viewId: string, cell: CellRef): void;
  /** Another person's committed edit arrives as a patch. */
  simulateRemoteEdit(viewId: string, rowKey: string, columnId: string, value: CellValue): void;
  revokeAccess(viewId: string, message?: string): void;
  /** Every batch the UI sent, for tests. */
  readonly sent: readonly CellEditBatch[];
  /** Every `setEditingCell` call, for tests. */
  readonly editingCalls: readonly (CellRef | null)[];
  /** Resolve edits immediately (default) or hold them until `flush()`. */
  setManualAck(manual: boolean): void;
  flush(): void;
}

export interface MockConnectionOptions {
  readonly actor: ActorRef;
  readonly schedules: readonly MockSchedule[];
  /** Milliseconds before `rows` arrives after open (0: next microtask). */
  readonly openDelayMs?: number;
}

export function createMockScheduleConnection(options: MockConnectionOptions): MockScheduleConnection {
  const state = new Map<string, { spec: MockSchedule; rows: MutableRow[]; revision: number; undo: { rowKey: string; columnId: string; parent?: CellRef["parent"]; before: CellValue }[][]; redo: { rowKey: string; columnId: string; parent?: CellRef["parent"]; before: CellValue }[][] }>();
  for (const s of options.schedules) state.set(s.viewId, { spec: s, rows: s.rows.map(toMutable), revision: 1, undo: [], redo: [] });
  const listeners = new Map<string, Set<(e: ScheduleEvent) => void>>();
  const presence = new Map<string, EditingPresence[]>();
  const sent: CellEditBatch[] = [];
  const editingCalls: (CellRef | null)[] = [];
  let manualAck = false;
  const pending: (() => void)[] = [];

  const emit = (viewId: string, e: ScheduleEvent) => listeners.get(viewId)?.forEach((l) => l(e));
  const emitPresence = (viewId: string) => emit(viewId, { type: "presence", editing: [...(presence.get(viewId) ?? [])] });

  const findRow = (s: { rows: MutableRow[] }, ref: CellRef): MutableRow | undefined => {
    if (ref.parent) {
      const parent = s.rows.find((r) => r.key === ref.parent?.rowKey);
      return parent?.children?.[ref.parent.columnId]?.find((c) => c.key === ref.rowKey);
    }
    return s.rows.find((r) => r.key === ref.rowKey);
  };

  const columnFor = (spec: MockSchedule, ref: CellRef): RowSetColumn | undefined => {
    if (ref.parent) return spec.columns.find((c) => c.id === ref.parent?.columnId)?.childColumns?.find((c) => c.id === ref.columnId);
    return spec.columns.find((c) => c.id === ref.columnId);
  };

  const upsertFor = (s: { spec: MockSchedule; revision: number }, row: MutableRow): RowUpsert => {
    const derived = s.spec.derive?.(row) ?? {};
    Object.assign(row.values, derived);
    const children: Record<string, RowSet> = {};
    for (const c of s.spec.columns) {
      if (c.kind === "expand" && c.childColumns && row.children?.[c.id]) children[c.id] = toRowSet(s.spec.viewId, s.revision, c.childColumns, row.children[c.id] ?? []);
    }
    return { rowKey: row.key, elementId: row.elementId, values: { ...row.values }, ...(Object.keys(children).length ? { children } : {}) };
  };

  const applyEdits = (viewId: string, writes: { ref: CellRef; value: CellValue }[], recordUndo: boolean) => {
    const s = state.get(viewId);
    if (!s) return;
    const touched = new Map<string, MutableRow>();
    const undoStep: { rowKey: string; columnId: string; parent?: CellRef["parent"]; before: CellValue }[] = [];
    for (const { ref, value } of writes) {
      const row = findRow(s, ref);
      if (!row) continue;
      undoStep.push({ rowKey: ref.rowKey, columnId: ref.columnId, ...(ref.parent ? { parent: ref.parent } : {}), before: row.values[ref.columnId] ?? null });
      row.values[ref.columnId] = value;
      const top = ref.parent ? s.rows.find((r) => r.key === ref.parent?.rowKey) : row;
      if (top) touched.set(top.key, top);
    }
    if (recordUndo && undoStep.length) {
      s.undo.push(undoStep);
      s.redo = [];
    }
    const from = s.revision;
    s.revision += 1;
    const patch: RowPatch = { viewId, fromRevision: from, toRevision: s.revision, upserts: [...touched.values()].map((r) => upsertFor(s, r)), removes: [] };
    emit(viewId, { type: "patch", patch });
    return undoStep;
  };

  /** Expands type-scope edits to every row of the same type (the blast radius). */
  const expand = (spec: MockSchedule, rows: MutableRow[], batch: CellEditBatch) => {
    const writes: { ref: CellRef; value: CellValue }[] = [];
    const impacts = new Map<string, { typeLabel: string; instanceCount: number; columnHeading: string }>();
    const refusals: (CellRef & { reason: string })[] = [];
    for (const e of batch.edits) {
      const column = columnFor(spec, e);
      const row = findRow({ rows }, e);
      if (!column || !row) {
        refusals.push({ rowKey: e.rowKey, columnId: e.columnId, ...(e.parent ? { parent: e.parent } : {}), reason: "That row is no longer in the schedule." });
        continue;
      }
      if (!column.writer) {
        refusals.push({ rowKey: e.rowKey, columnId: e.columnId, ...(e.parent ? { parent: e.parent } : {}), reason: column.lockedReason ?? "This value is calculated." });
        continue;
      }
      const refusal = spec.validate?.(row, e.columnId, e.value);
      if (refusal) {
        refusals.push({ rowKey: e.rowKey, columnId: e.columnId, ...(e.parent ? { parent: e.parent } : {}), reason: refusal });
        continue;
      }
      if (column.writer.scope === "type" && row.typeId && !e.parent) {
        const t = spec.types?.[row.typeId];
        impacts.set(`${row.typeId}|${column.id}`, { typeLabel: t?.label ?? row.typeId, instanceCount: t?.instanceCount ?? rows.filter((r) => r.typeId === row.typeId).length, columnHeading: column.heading });
        for (const r of rows) if (r.typeId === row.typeId) writes.push({ ref: { rowKey: r.key, columnId: e.columnId }, value: e.value });
      } else writes.push({ ref: e, value: e.value });
    }
    return { writes, impacts: [...impacts.values()], refusals };
  };

  const connection: MockScheduleConnection = {
    actor: options.actor,
    sent,
    editingCalls,
    setManualAck(manual) {
      manualAck = manual;
    },
    flush() {
      while (pending.length) pending.shift()?.();
    },
    open(target: ScheduleTarget, listener) {
      const viewId = "viewId" in target ? target.viewId : target.definition.name;
      const s = state.get(viewId);
      let set = listeners.get(viewId);
      if (!set) {
        set = new Set();
        listeners.set(viewId, set);
      }
      set.add(listener);
      let open = true;
      const deliver = () => {
        if (!open) return;
        if (!s) {
          listener({ type: "closed", reason: "deleted", message: "This schedule was deleted from the model." });
          return;
        }
        listener({ type: "rows", rows: toRowSet(viewId, s.revision, s.spec.columns, s.rows) });
        listener({ type: "presence", editing: [...(presence.get(viewId) ?? [])] });
      };
      if (options.openDelayMs && options.openDelayMs > 0) setTimeout(deliver, options.openDelayMs);
      else queueMicrotask(deliver);

      const sub: ScheduleSubscription = {
        close() {
          open = false;
          set?.delete(listener);
        },
        requestWindow() {
          // The mock always sends every row; windows matter only on the wire.
        },
        async preview(batch): Promise<EditPreview> {
          if (!s) return { typeScope: [], refusals: [] };
          const { impacts, refusals } = expand(s.spec, s.rows, batch);
          return { typeScope: impacts, refusals };
        },
        edit(batch): Promise<EditOutcome> {
          sent.push(batch);
          return new Promise((resolve) => {
            const run = () => {
              if (!s) return resolve({ ok: false, message: "This schedule is no longer open." });
              const { writes, refusals } = expand(s.spec, s.rows, batch);
              if (writes.length) applyEdits(viewId, writes, true);
              resolve({ ok: true, revision: s.revision, refusals });
            };
            if (manualAck) pending.push(run);
            else queueMicrotask(run);
          });
        },
        setEditingCell(cell) {
          editingCalls.push(cell);
        },
        async explain(cell) {
          if (!s) return null;
          const row = findRow(s, cell);
          return row ? (s.spec.explain?.(row, cell.columnId) ?? null) : null;
        },
        undo() {
          if (!s) return;
          const step = s.undo.pop();
          if (!step) return;
          const redoStep = applyEdits(
            viewId,
            step.map((u) => ({ ref: { rowKey: u.rowKey, columnId: u.columnId, ...(u.parent ? { parent: u.parent } : {}) }, value: u.before })),
            false,
          );
          if (redoStep) s.redo.push(redoStep);
        },
        redo() {
          if (!s) return;
          const step = s.redo.pop();
          if (!step) return;
          const undoStep = applyEdits(
            viewId,
            step.map((u) => ({ ref: { rowKey: u.rowKey, columnId: u.columnId, ...(u.parent ? { parent: u.parent } : {}) }, value: u.before })),
            false,
          );
          if (undoStep) s.undo.push(undoStep);
        },
      };
      return sub;
    },
    simulateEditing(actor, viewId, cell, ttlMs = EDITING_CELL_MAX_TTL_MS) {
      const list = (presence.get(viewId) ?? []).filter((p) => !(p.actor.id === actor.id));
      list.push({ ...cell, actor, expiresAt: Date.now() + Math.min(ttlMs, EDITING_CELL_MAX_TTL_MS) });
      presence.set(viewId, list);
      emitPresence(viewId);
    },
    simulateRelease(actor, viewId, cell) {
      presence.set(
        viewId,
        (presence.get(viewId) ?? []).filter((p) => !(p.actor.id === actor.id && p.rowKey === cell.rowKey && p.columnId === cell.columnId)),
      );
      emitPresence(viewId);
    },
    simulateRemoteEdit(viewId, rowKey, columnId, value) {
      applyEdits(viewId, [{ ref: { rowKey, columnId }, value }], false);
    },
    revokeAccess(viewId, message = "You no longer have access to this model.") {
      emit(viewId, { type: "closed", reason: "denied", message });
    },
  };
  return connection;
}
