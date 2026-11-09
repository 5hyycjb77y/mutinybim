"use client";

import { DataGrid, type DataGridHandle, type GridEditIntent } from "@permitzip/bim-grid";
import { Alert, AlertDescription, AlertTitle, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Spinner } from "@permitzip/bim-ui";
import { Columns3, Crosshair, ListOrdered } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyRowPatch } from "./apply-patch";
import {
  EDITING_CELL_MAX_TTL_MS,
  type CellEditBatch,
  type CellRef,
  type EditingPresence,
  type RowSet,
  type RowSetColumn,
  type ScheduleClosedReason,
  type ScheduleConnection,
  type ScheduleSubscription,
  type ScheduleTarget,
  type TypeScopeImpact,
} from "./contracts";
import { buildGridModel, cellKey, intentToEdits, rowSetToCsv, type CellOverlay } from "./rowset-grid";
import { ConfirmDialog, OverflowMenu, type MenuItem } from "./ui/overlays";
import { createScheduleUnits, type ScheduleUnits } from "./units";

export type BuilderSection = "fields" | "arrange";

export interface ScheduleGridProps {
  readonly connection: ScheduleConnection;
  readonly target: ScheduleTarget;
  /** As the person knows it: "Water heater schedule". */
  readonly title: string;
  readonly units?: ScheduleUnits;
  readonly height?: number;
  /** Fields / Arrange open the builder at that section. */
  readonly onOpenBuilder?: (section: BuilderSection) => void;
  /** Columns: change the schedule one column at a time (each change one undo step). Shown instead of Fields when given. */
  readonly onOpenColumns?: () => void;
  /** Select these elements in plan and 3D. */
  readonly onShowInModel?: (elementIds: readonly string[]) => void;
  /** Jump to where a locked value comes from (formula, related item, type). */
  readonly onGoToSource?: (column: RowSetColumn, cell: CellRef, elementId: string | null) => void;
  readonly onPlaceOnSheet?: () => void;
  readonly onDuplicate?: () => void;
  readonly onSaveAsTemplate?: () => void;
  readonly onPrintPreview?: () => void;
  /** Absent: Export CSV downloads a file. */
  readonly onExportCsv?: (csv: string, filename: string) => void;
  /** Column widths the person set before (host-stored per-person prefs). */
  readonly columnWidths?: Readonly<Record<string, number>>;
  readonly onColumnWidthsChange?: (widths: Readonly<Record<string, number>>) => void;
  readonly frozenColumns?: number;
}

type Status =
  | { readonly kind: "loading" }
  | { readonly kind: "ready" }
  | { readonly kind: "closed"; readonly reason: ScheduleClosedReason; readonly message: string };

interface HeldBatch {
  readonly batch: CellEditBatch;
  readonly texts: ReadonlyMap<string, string>;
  readonly keys: readonly string[];
  readonly heldSince: number;
}

const SAVED_FLASH_MS = 1500;

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** A model schedule as a live spreadsheet. See SCHEDULES-PLAN §6–§7. */
export function ScheduleGrid(props: ScheduleGridProps) {
  const { connection, target, title, height = 520, onOpenBuilder, onShowInModel, onGoToSource } = props;
  const units = useMemo(() => props.units ?? createScheduleUnits(), [props.units]);
  const me = connection.actor;

  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [reconnecting, setReconnecting] = useState(false);
  const [rowSet, setRowSet] = useState<RowSet | null>(null);
  const [presence, setPresence] = useState<readonly EditingPresence[]>([]);
  /** "Now" for presence TTLs; ticks at the next expiry and on every presence event. */
  const [presenceClock, setPresenceClock] = useState(() => Date.now());
  const [overlays, setOverlays] = useState<ReadonlyMap<string, CellOverlay>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [explanations, setExplanations] = useState<ReadonlyMap<string, string>>(new Map());
  const [widths, setWidths] = useState<ReadonlyMap<string, number>>(() => new Map(Object.entries(props.columnWidths ?? {})));
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<{ batch: CellEditBatch; texts: ReadonlyMap<string, string>; impacts: readonly TypeScopeImpact[] } | null>(null);
  const [activeRow, setActiveRow] = useState<{ elementId: string | null } | null>(null);

  const subRef = useRef<ScheduleSubscription | null>(null);
  const heldRef = useRef<HeldBatch[]>([]);
  /** Bumped when an edit is held, so the release timer re-arms even if nobody's presence changes. */
  const [heldTick, setHeldTick] = useState(0);
  const gridRef = useRef<DataGridHandle>(null);
  const presenceRef = useRef<readonly EditingPresence[]>([]);

  const viewKey = "viewId" in target ? target.viewId : target.definition.name;
  // Re-open only when the schedule changes, not when a parent re-creates the target object.
  const targetRef = useRef(target);
  const widthsChangeRef = useRef(props.onColumnWidthsChange);
  useLayoutEffect(() => {
    targetRef.current = target;
    widthsChangeRef.current = props.onColumnWidthsChange;
  });

  // A different schedule starts from "loading" (reset during render, not in an effect).
  const [openedKey, setOpenedKey] = useState(viewKey);
  if (openedKey !== viewKey) {
    setOpenedKey(viewKey);
    setStatus({ kind: "loading" });
    setRowSet(null);
  }

  useEffect(() => {
    const sub = connection.open(targetRef.current, (event) => {
      switch (event.type) {
        case "rows":
          setRowSet(event.rows);
          setStatus({ kind: "ready" });
          return;
        case "patch":
          setRowSet((rs) => (rs ? applyRowPatch(rs, event.patch) : rs));
          return;
        case "closed":
          setStatus({ kind: "closed", reason: event.reason, message: event.message });
          return;
        case "presence": {
          const others = event.editing.filter((p) => p.actor.id !== me.id);
          presenceRef.current = others;
          setPresence(others);
          setPresenceClock(Date.now());
          return;
        }
        case "connection":
          setReconnecting(event.state === "reconnecting");
          return;
      }
    });
    subRef.current = sub;
    return () => {
      sub.setEditingCell(null);
      sub.close();
      subRef.current = null;
    };
  }, [connection, viewKey, me.id]);

  const setOverlay = useCallback((updates: readonly (readonly [string, CellOverlay | null])[]) => {
    setOverlays((prev) => {
      const next = new Map(prev);
      for (const [k, v] of updates) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    });
  }, []);

  const send = useCallback(
    async (batch: CellEditBatch, texts: ReadonlyMap<string, string>) => {
      const sub = subRef.current;
      if (!sub) return;
      const keys = batch.edits.map((e) => cellKey(e));
      setOverlay(keys.map((k) => [k, { state: "pending", text: texts.get(k) ?? "" }] as const));
      setMessage(`Saving ${plural(batch.edits.length, "change")}…`);
      try {
        const outcome = await sub.edit(batch);
        if (!outcome.ok) {
          setOverlay(keys.map((k) => [k, { state: "refused", reason: outcome.message, text: texts.get(k) ?? "" }] as const));
          setMessage(`Not saved: ${outcome.message}`);
          return;
        }
        const refusedKeys = new Map(outcome.refusals.map((r) => [cellKey(r), r.reason] as const));
        setOverlay(keys.map((k) => [k, refusedKeys.has(k) ? { state: "refused", reason: refusedKeys.get(k) ?? "", text: texts.get(k) ?? "" } : { state: "saved" }] as const));
        const savedCount = keys.length - refusedKeys.size;
        if (refusedKeys.size === 0) setMessage(savedCount === 1 ? "Saved." : `Saved ${plural(savedCount, "change")}.`);
        else setMessage(`Saved ${savedCount} of ${keys.length}. ${plural(refusedKeys.size, "cell")} weren't changed: ${[...refusedKeys.values()][0] ?? ""}`);
        setTimeout(() => {
          setOverlays((prev) => {
            const next = new Map(prev);
            for (const k of keys) if (next.get(k)?.state === "saved") next.delete(k);
            return next;
          });
        }, SAVED_FLASH_MS);
      } catch (err) {
        console.error("[ScheduleGrid] edit failed", err);
        const reason = err instanceof Error ? err.message : "The connection dropped before the change was saved.";
        setOverlay(keys.map((k) => [k, { state: "refused", reason, text: texts.get(k) ?? "" }] as const));
        setMessage(`Not saved: ${reason} Try again.`);
      }
    },
    [setOverlay],
  );

  /** Type-scope edits ask first (D2): preview the blast radius, Cancel is the default. */
  const previewAndSend = useCallback(
    async (batch: CellEditBatch, texts: ReadonlyMap<string, string>) => {
      const sub = subRef.current;
      if (!sub) return;
      try {
        const preview = await sub.preview(batch);
        if (preview.typeScope.length > 0) {
          setConfirm({ batch, texts, impacts: preview.typeScope });
          return;
        }
      } catch (err) {
        console.error("[ScheduleGrid] preview failed", err);
        setMessage("Couldn't check what this change affects. Nothing was changed; try again.");
        return;
      }
      await send(batch, texts);
    },
    [send],
  );

  const othersInCell = useCallback((key: string) => presenceRef.current.find((p) => cellKey(p) === key && p.expiresAt > Date.now()), []);

  /** Releases held edits whose cells are free (other person done, or TTL over). */
  const releaseHeld = useCallback(() => {
    const now = Date.now();
    const still: HeldBatch[] = [];
    for (const h of heldRef.current) {
      const blocked = h.keys.some((k) => othersInCell(k)) && now - h.heldSince < EDITING_CELL_MAX_TTL_MS;
      if (blocked) still.push(h);
      else void previewAndSend(h.batch, h.texts);
    }
    heldRef.current = still;
  }, [othersInCell, previewAndSend]);

  useEffect(() => {
    releaseHeld();
    if (heldRef.current.length === 0) return;
    const nextExpiry = Math.min(
      ...heldRef.current.map((h) => h.heldSince + EDITING_CELL_MAX_TTL_MS),
      ...presence.map((p) => p.expiresAt),
    );
    const t = setTimeout(() => {
      releaseHeld();
      setHeldTick((n) => n + 1);
    }, Math.max(0, nextExpiry - Date.now()) + 10);
    return () => clearTimeout(t);
  }, [presence, releaseHeld, heldTick]);

  // Presence past its TTL stops drawing even if the other client never sends a release.
  const livePresence = useMemo(() => presence.filter((p) => p.expiresAt > presenceClock), [presence, presenceClock]);
  useEffect(() => {
    if (livePresence.length === 0) return;
    const next = Math.min(...livePresence.map((p) => p.expiresAt));
    const t = setTimeout(() => setPresenceClock(Date.now()), Math.max(0, next - Date.now()) + 10);
    return () => clearTimeout(t);
  }, [livePresence]);

  const model = useMemo(
    () =>
      rowSet
        ? buildGridModel({
            rowSet,
            units,
            expanded,
            overlays,
            presence: livePresence,
            explanations,
            widths,
            onGoToSource: (column, cell) => {
              const el = cell.parent ? null : (rowSet.elementIds[rowSet.rowKeys.indexOf(cell.rowKey)] ?? null);
              onGoToSource?.(column, cell, el);
            },
          })
        : null,
    [rowSet, units, expanded, overlays, livePresence, explanations, widths, onGoToSource],
  );

  const onEdit = useCallback(
    (intent: GridEditIntent) => {
      if (!model) return;
      const { edits, refused, texts } = intentToEdits(intent, model, units);
      if (refused.length) {
        setOverlay(refused.filter((r) => r.text !== "").map((r) => [cellKey(r.ref), { state: "refused", reason: r.reason, text: r.text }] as const));
        const first = refused[0];
        if (first) setMessage(edits.length ? `${plural(refused.length, "cell")} skipped: ${first.reason}` : `Not changed: ${first.reason}`);
      }
      if (edits.length === 0) return;
      const batch: CellEditBatch = { source: intent.source, edits };
      const keys = edits.map((e) => cellKey(e));
      const holder = keys.map((k) => othersInCell(k)).find(Boolean);
      if (holder) {
        heldRef.current = [...heldRef.current, { batch, texts, keys, heldSince: Date.now() }];
        setHeldTick((n) => n + 1);
        setOverlay(keys.map((k) => [k, { state: "held", heldBy: holder.actor.name, text: texts.get(k) ?? "" }] as const));
        setMessage(`${holder.actor.name} is editing this cell. Your change will be sent when they finish.`);
        return;
      }
      void previewAndSend(batch, texts);
    },
    [model, units, setOverlay, othersInCell, previewAndSend],
  );

  const onActiveCellChange = useCallback(
    (cell: { rowKey: string; columnId: string } | null) => {
      if (!model || !cell) {
        setActiveRow(null);
        return;
      }
      const resolved = model.resolve(cell.rowKey, cell.columnId);
      setActiveRow({ elementId: resolved.elementId });
      const key = cellKey(resolved.ref);
      if (resolved.column && !resolved.column.writer && resolved.column.source && !explanations.has(key)) {
        subRef.current
          ?.explain(resolved.ref)
          .then((text) => {
            if (text) setExplanations((prev) => new Map(prev).set(key, text));
          })
          .catch((err: unknown) => console.error("[ScheduleGrid] explain failed (non-blocking)", err));
      }
    },
    [model, explanations],
  );

  const onEditingChange = useCallback(
    (cell: { rowKey: string; columnId: string } | null) => {
      if (!model) return;
      subRef.current?.setEditingCell(cell ? model.resolve(cell.rowKey, cell.columnId).ref : null);
    },
    [model],
  );

  const onToggleExpand = useCallback((rowKey: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);

  const onColumnResize = useCallback((columnId: string, width: number) => {
    setWidths((prev) => {
      const next = new Map(prev).set(columnId, width);
      widthsChangeRef.current?.(Object.fromEntries(next));
      return next;
    });
  }, []);

  const exportCsv = () => {
    if (!rowSet) return;
    const csv = rowSetToCsv(rowSet, units);
    const filename = `${title.replace(/[^\w-]+/g, "-").toLowerCase()}.csv`;
    if (props.onExportCsv) props.onExportCsv(csv, filename);
    else downloadCsv(csv, filename);
    setMessage(`Exported ${plural(rowSet.rowCount, "row")} to ${filename}.`);
  };

  const notHere = "Not available in this view.";
  const menuItems: MenuItem[] = [
    { label: "Place on sheet", ...(props.onPlaceOnSheet ? { onSelect: props.onPlaceOnSheet } : { disabledReason: notHere }) },
    { label: "Duplicate", ...(props.onDuplicate ? { onSelect: props.onDuplicate } : { disabledReason: notHere }) },
    { label: "Save as template", ...(props.onSaveAsTemplate ? { onSelect: props.onSaveAsTemplate } : { disabledReason: notHere }) },
    { label: "Export CSV", ...(rowSet ? { onSelect: exportCsv } : { disabledReason: "Wait for the rows to load." }) },
    { label: "Print preview", ...(props.onPrintPreview ? { onSelect: props.onPrintPreview } : { disabledReason: notHere }) },
  ];

  const showInModelReason = !onShowInModel ? "Not available in this view." : !activeRow?.elementId ? "Pick a row first." : null;

  return (
    <section className="mutiny-sched" aria-label={title}>
      <div className="mutiny-sched-toolbar" role="toolbar" aria-label={`${title} tools`}>
        <h2 className="mutiny-sched-title">{title}</h2>
        <div className="mutiny-sched-toolbar-actions">
          {props.onOpenColumns ? (
            <Button variant="outline" size="sm" onClick={props.onOpenColumns} title="Add, remove, move, rename, sort, group and total columns; each change undoes on its own" data-testid="schedule-columns-open">
              <Columns3 aria-hidden /> Columns
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => onOpenBuilder?.("fields")} disabled={!onOpenBuilder} title={onOpenBuilder ? "Choose what this schedule lists and which columns it shows" : notHere}>
              <Columns3 aria-hidden /> Fields
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenBuilder?.("arrange")} disabled={!onOpenBuilder} title={onOpenBuilder ? "Sort, group and total" : notHere}>
            <ListOrdered aria-hidden /> Arrange
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={showInModelReason !== null}
            title={showInModelReason ?? "Select this row's item in plan and 3D"}
            onClick={() => activeRow?.elementId && onShowInModel?.([activeRow.elementId])}
          >
            <Crosshair aria-hidden /> Show in model
          </Button>
          <OverflowMenu label="More schedule actions" items={menuItems} />
        </div>
      </div>
      <p className="mutiny-sched-status" role="status" aria-live="polite">
        {reconnecting ? "Connection lost. Reconnecting… your unsaved edits are kept." : message}
      </p>
      {status.kind === "loading" ? (
        <div className="mutiny-sched-loading" style={{ height }}>
          <Spinner /> Loading {title}…
        </div>
      ) : status.kind === "closed" ? (
        <Alert variant={status.reason === "denied" ? "destructive" : "default"}>
          <AlertTitle>{status.reason === "denied" ? "You can't see this schedule any more" : status.reason === "deleted" ? "This schedule was deleted" : "This schedule was closed"}</AlertTitle>
          <AlertDescription>
            {status.message} {status.reason === "denied" ? "Ask the project lead for access, then open it again." : "Open another schedule from Views and Sheets."}
          </AlertDescription>
        </Alert>
      ) : model ? (
        <DataGrid
          ref={gridRef}
          ariaLabel={title}
          rows={model.rows}
          columns={model.columns}
          hierarchical={model.hierarchical}
          frozenColumns={props.frozenColumns ?? 1}
          height={height}
          onEdit={onEdit}
          onToggleExpand={onToggleExpand}
          onUndo={() => subRef.current?.undo()}
          onRedo={() => subRef.current?.redo()}
          onActiveCellChange={onActiveCellChange}
          onEditingChange={onEditingChange}
          onColumnResize={onColumnResize}
          emptyState={
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing to list yet</EmptyTitle>
                <EmptyDescription>No items in the model match this schedule. Change what it lists with {props.onOpenColumns ? "Columns › What it lists, formulas and paper" : "Fields"}.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title="Change every part of this type?"
        confirmLabel={confirm ? `Change all ${confirm.impacts.reduce((n, i) => n + i.instanceCount, 0).toLocaleString("en-US")}` : "Change all"}
        onCancel={() => {
          if (confirm) {
            setOverlay(confirm.batch.edits.map((e) => [cellKey(e), null] as const));
            setMessage("Not changed.");
          }
          setConfirm(null);
          gridRef.current?.focus();
        }}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          gridRef.current?.focus();
          if (c) void send(c.batch, c.texts);
        }}
      >
        <ul className="mutiny-sched-impacts">
          {(confirm?.impacts ?? []).map((i) => (
            <li key={`${i.typeLabel}|${i.columnHeading}`}>
              Changes all {plural(i.instanceCount, "part")} of type {i.typeLabel} ({i.columnHeading}), including any not in this schedule.
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </section>
  );
}
