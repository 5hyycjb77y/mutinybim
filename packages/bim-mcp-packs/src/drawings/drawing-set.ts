import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  documentIndex,
  isQuestionCommand,
  layoutSheet,
  scaleLabel,
  type ModelState,
  type SheetRevision,
} from "@permitzip/bim-kernel";
import { revisionTableProblem, sheetLayoutCommand } from "@permitzip/bim-editor/contracts/building-model/sheet-commands";
import { baseRevision, explain, failure, runEdit, target, text, withSession, type Extra, type ResolveBimCaller } from "../runtime";
import {
  NOTE_FONTS_DIR,
  editWithModel,
  previewBranchOf,
  previewTokenProblem,
  findSheet,
  findView,
  parseDocumentCommand,
  pointFt,
  previewDocumentEdit,
  scaleInput,
  stableId,
} from "../views/views";
import { agentSheetTitle } from "../views/sheet-title";
import { sheetBlockReport } from "./block-snapshots";
import type { DrawingSetToolsHost } from "./capabilities";
import { checkDrawingSetIssue, drawingSetHistory, issueDrawingSetFor, printDrawingSet, type DrawingSetContext, type OpenSession } from "./set-printing";

/**
 * Drawing-set tools for agents: save exactly what was previewed (any views and
 * sheets command, or a batch of them under one approval), the explicit view,
 * sheet and viewport edits, deterministic sheet layout, printing a whole set to one PDF, and issuing it from a captured
 * snapshot. Every model change goes through the same authority edit path as
 * the browser and pauses for approval in Cmd+J.
 */

const IN = 25.4;

/** Sheet ids a set check covers: the named ones, else every sheet that carries a live block. */
function blockSheetIds(model: ModelState, sheets: readonly string[] | undefined): string[] {
  const index = documentIndex(model);
  const ids = sheets ? sheets.flatMap((ref) => findSheet(model, ref) ?? []) : index.sheets.map((sh) => sh.id);
  return ids.filter((id) => (index.itemsByOwner.get(id) ?? []).some((i) => i.shape === "field_block"));
}

const viewRef = z.string().min(1).max(200).describe("View id or exact name.");
const sheetRef = z.string().min(1).max(200).describe("Sheet id or number, e.g. M-101.");
const revisionInput = z.object({
  number: z.string().trim().min(1).max(10).describe("Revision number or letter as it prints, e.g. 1 or A."),
  date: z.string().trim().min(1).max(20).describe("As it prints, e.g. 2026-10-20."),
  description: z.string().trim().min(1).max(80).describe("e.g. ISSUED FOR PERMIT."),
});
const requiredBase = {
  base_revision: z.number().int().min(0).describe("The revision the preview ran at (its `revision`)."),
  preview_token: z.string().min(16).max(64).describe("The preview_token the preview returned for this exact change."),
};

function findViewport(model: ModelState, ref: string, sheet: string | undefined): string | null {
  const index = documentIndex(model);
  if (model.elements[ref]?.kind === "viewport") return ref;
  const viewId = findView(model, ref);
  const vp = viewId ? index.viewportByView.get(viewId) : undefined;
  if (!vp) return null;
  if (sheet) {
    const sheetId = findSheet(model, sheet);
    if (sheetId !== vp.sheetId) return null;
  }
  return vp.id;
}

const layoutInput = {
  sheet: sheetRef,
  mode: z.enum(["pack", "grid"]).default("pack").describe("pack: rows left to right in order; grid: aligned equal cells."),
  columns: z.number().int().min(1).max(12).optional().describe("Grid only: number of columns."),
  gap_in: z.number().min(0).max(4).optional().describe('Space between frames, inches (default 1/2").'),
  fit_scales: z.boolean().optional().describe("Shrink a view's scale (standard scales only, never enlarging) when it doesn't fit the sheet."),
  smallest_scale: scaleInput.describe('Smallest drawing allowed when fitting, as model units per paper unit (default 192 = 1/16" = 1\'-0").'),
  order: z.array(z.string().min(1).max(200)).max(100).optional().describe("View names or ids in the order to lay out; absent: the sheet's view order."),
};

type LayoutArgs = { sheet: string; mode: "pack" | "grid"; columns?: number; gap_in?: number; fit_scales?: boolean; smallest_scale?: number; order?: string[] };

function layoutOptions(model: ModelState, args: LayoutArgs) {
  const order = args.order?.map((ref) => findViewport(model, ref, args.sheet) ?? ref);
  return {
    mode: args.mode,
    ...(args.columns !== undefined ? { columns: args.columns } : {}),
    ...(args.gap_in !== undefined ? { gapMm: args.gap_in * IN } : {}),
    ...(args.fit_scales !== undefined ? { fitScales: args.fit_scales } : {}),
    ...(args.smallest_scale !== undefined ? { minScale: args.smallest_scale } : {}),
    ...(order ? { order } : {}),
  };
}

function layoutReport(model: ModelState, layout: ReturnType<typeof layoutSheet>) {
  return {
    drawing_area_in: { left: layout.area.min.x / IN, top: layout.area.min.y / IN, right: layout.area.max.x / IN, bottom: layout.area.max.y / IN },
    moves: layout.moves.map((m) => ({ view: m.viewName, center_in: { x: Math.round((m.center.x / IN) * 100) / 100, y: Math.round((m.center.y / IN) * 100) / 100 }, ...(m.scale !== undefined ? { new_scale: scaleLabel(m.scale) } : {}) })),
    could_not_place: layout.unplaced.map((u) => ({ view: u.viewName, reason: u.reason })),
    revision: model.revision,
  };
}

export function registerBimDrawingSetTools(server: McpServer, caller: ResolveBimCaller, stores: DrawingSetToolsHost) {
  const { blockSnapshots, sheetTitle, setFiles, backgrounds, sheetImages, issueCheck, questionNotices } = stores;

  // ── Save what was previewed ────────────────────────────────────────────────

  server.registerTool(
    "bim_apply_views_sheets_edit",
    {
      title: "Save a previewed views or sheets change",
      description:
        "Save exactly the change bim_preview_views_sheets_edit returned: the same command (one views/sheets command or a batch_documents of up to 500), its base_revision and its preview_token. Anything different is refused before it is sent, so what the person approves is what saves. Retrying the same call never saves it twice. If someone changed the same things since the preview, nothing is saved and you get a conflict: preview again.",
      inputSchema: { ...target, ...requiredBase, command: z.record(z.string(), z.unknown()) },
    },
    async (args, extra) => {
      const command = parseDocumentCommand(args.command);
      if (typeof command === "string") return failure(command);
      // The branch the thread edits now is part of what was previewed (round 9 B9).
      const onBranch = (await caller(extra, args.project_id, true)).branchId ?? null;
      const stale = previewTokenProblem({ modelId: args.model_id, branchId: onBranch, command, revision: args.base_revision, token: args.preview_token, otherwise: `This isn't the change that was previewed at Rev ${args.base_revision}: the command or revision differs from the preview. Preview it again and apply with the new preview_token.` });
      if (stale) return failure(stale);
      // Round 9 lane Q9: a saved question command tells the asker, owner and person asked (the bell).
      const held: { saved: ModelState | null } = { saved: null };
      const result = await runEdit(caller, "bim_apply_views_sheets_edit", extra, args, command, { model_id: args.model_id, preview_token: args.preview_token }, (m) => ((held.saved = m), {}));
      const saved = held.saved;
      if (saved && isQuestionCommand(command)) {
        try {
          const told = await questionNotices({ extra, projectId: args.project_id, modelId: args.model_id, command, saved });
          if (told.failed) console.error("[bim_apply_views_sheets_edit] question notice not written", { modelId: args.model_id, failed: told.failed });
        } catch (err) {
          console.error("[bim_apply_views_sheets_edit] question notice not written (the edit is saved)", { modelId: args.model_id, err });
        }
      }
      return result;
    },
  );

  // ── Views ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "bim_rename_view",
    { title: "Rename a view", description: "Rename a view. Refused if another view has that name. Its sheet titles follow.", inputSchema: { ...target, ...baseRevision, view: viewRef, name: z.string().trim().min(1).max(120) } },
    async (args, extra) =>
      editWithModel(caller, "bim_rename_view", extra, args, (model) => {
        const viewId = findView(model, args.view);
        return viewId ? { type: "rename_view", viewId, name: args.name } : `No view "${args.view}". List views and sheets first.`;
      }),
  );

  server.registerTool(
    "bim_duplicate_view",
    {
      title: "Duplicate a view",
      description: "Copy a view with its properties and crop (and a detail view's drawing) under a new name (default \"<name> Copy\"). The copy isn't on a sheet. Use it to show the same plan twice, e.g. an enlarged plan.",
      inputSchema: { ...target, ...baseRevision, view: viewRef, name: z.string().trim().min(1).max(120).optional() },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_duplicate_view", extra, args, (model) => {
        const viewId = findView(model, args.view);
        if (!viewId) return `No view "${args.view}". List views and sheets first.`;
        return { type: "duplicate_view", viewId, newViewId: stableId("view", extra, { ...args, base_revision: undefined }), ...(args.name ? { name: args.name } : {}) };
      }),
  );

  server.registerTool(
    "bim_delete_view",
    {
      title: "Delete a view",
      description: "Delete a view. A view placed on a sheet is refused unless if_placed is remove_from_sheet (its viewport goes too). Undo brings it back.",
      inputSchema: { ...target, ...baseRevision, view: viewRef, if_placed: z.enum(["refuse", "remove_from_sheet"]).default("refuse") },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_delete_view", extra, args, (model) => {
        const viewId = findView(model, args.view);
        return viewId ? { type: "delete_view", viewId, placed: args.if_placed } : `No view "${args.view}". List views and sheets first.`;
      }),
  );

  // ── Sheets and title blocks ────────────────────────────────────────────────

  server.registerTool(
    "bim_set_sheet_properties",
    {
      title: "Change a sheet's title block",
      description:
        "Change a sheet's number, name, title block size, title block fields (client, address, drawn_by, checked_by, date, status, or any other key; an empty string clears one), and its revision table: add_revision appends one row; revisions replaces the whole table (oldest first). Refused if the number is taken, a revision number repeats, or a smaller title block can't hold its viewports.",
      inputSchema: {
        ...target,
        ...baseRevision,
        sheet: sheetRef,
        number: z.string().trim().min(1).max(40).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        title_block: z.enum(["arch_d_mutinybim", "ansi_b_mutinybim"]).optional(),
        fields: z.record(z.string().min(1).max(40), z.string().max(200)).optional(),
        add_revision: revisionInput.optional(),
        revisions: z.array(revisionInput).max(20).optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_set_sheet_properties", extra, args, (model) => {
        const sheetId = findSheet(model, args.sheet);
        const sheet = sheetId ? model.elements[sheetId] : undefined;
        if (!sheetId || sheet?.kind !== "sheet") return `No sheet "${args.sheet}". List views and sheets first.`;
        if (args.add_revision && args.revisions) return "Give add_revision (one new row) or revisions (the whole table), not both.";
        let revisions: SheetRevision[] | undefined = args.revisions;
        if (args.add_revision) revisions = [...(sheet.props?.revisions ?? []), args.add_revision];
        const problem = revisions ? revisionTableProblem(sheet.number, revisions) : null;
        if (problem) return problem;
        if ([args.number, args.name, args.title_block, args.fields, revisions].every((v) => v === undefined)) return "Nothing to change: give a number, name, title_block, fields, add_revision or revisions.";
        return {
          type: "set_sheet_properties",
          sheetId,
          ...(args.number !== undefined ? { number: args.number } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.title_block !== undefined ? { titleBlock: args.title_block } : {}),
          ...(args.fields !== undefined ? { fields: args.fields } : {}),
          ...(revisions !== undefined ? { revisions } : {}),
        };
      }),
  );

  server.registerTool(
    "bim_delete_sheet",
    {
      title: "Delete a sheet",
      description: "Delete a sheet with its viewports, notes and linework. Its views are kept (no longer placed). Undo brings it back.",
      inputSchema: { ...target, ...baseRevision, sheet: sheetRef },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_delete_sheet", extra, args, (model) => {
        const sheetId = findSheet(model, args.sheet);
        return sheetId ? { type: "delete_sheet", sheetId } : `No sheet "${args.sheet}". List views and sheets first.`;
      }),
  );

  // ── Viewports ──────────────────────────────────────────────────────────────

  server.registerTool(
    "bim_edit_viewport",
    {
      title: "Move, resize, rescale or remove a viewport",
      description:
        "Change a placed view on its sheet. action move: centre_in on paper (inches from the sheet's top-left). resize: the frame's size_in (the view's crop box follows at the viewport's scale; optional centre_in). scale: a new drawing scale (the frame grows or shrinks; the crop box stays). A live diagram or schedule is its own size: move only. A frame past the drawing area saves with a warning. north_arrow: show or hide. remove: take it off the sheet (the view is kept). Name the viewport by its view's name or id (optionally the sheet), or the viewport id. To place many at once, use bim_auto_layout_sheet.",
      inputSchema: {
        ...target,
        ...baseRevision,
        viewport: z.string().min(1).max(200).describe("The placed view's name or id, or the viewport id."),
        sheet: sheetRef.optional(),
        action: z.enum(["move", "resize", "scale", "north_arrow", "remove"]),
        center_in: pointFt.optional().describe("Paper inches from the sheet's top-left."),
        size_in: pointFt.optional().describe("Frame width (x) and height (y), paper inches."),
        scale: scaleInput,
        show: z.boolean().optional(),
      },
    },
    async (args, extra) =>
      editWithModel(caller, "bim_edit_viewport", extra, args, (model) => {
        const viewportId = findViewport(model, args.viewport, args.sheet);
        if (!viewportId) return `No placed view "${args.viewport}"${args.sheet ? ` on sheet ${args.sheet}` : ""}. List views and sheets first.`;
        const center = args.center_in ? { x: args.center_in.x * IN, y: args.center_in.y * IN } : undefined;
        switch (args.action) {
          case "move":
            return center ? { type: "move_viewport", viewportId, center } : "Moving needs center_in.";
          case "resize":
            return args.size_in ? { type: "resize_viewport", viewportId, size: { x: args.size_in.x * IN, y: args.size_in.y * IN }, ...(center ? { center } : {}) } : "Resizing needs size_in.";
          case "scale":
            return args.scale ? { type: "set_viewport_scale", viewportId, scale: args.scale } : "Rescaling needs scale.";
          case "north_arrow":
            return args.show === undefined ? "Give show: true or false." : { type: "set_viewport_north_arrow", viewportId, show: args.show };
          case "remove":
            return { type: "remove_viewport", viewportId };
        }
      }),
  );

  // ── Layout ─────────────────────────────────────────────────────────────────

  server.registerTool(
    "bim_preview_sheet_layout",
    {
      title: "Preview a sheet layout",
      description:
        "Work out where every viewport on a sheet should go, without saving: frames packed in rows (or an aligned grid) inside the border and left of the title block, with room under each for its title; optionally shrinking a view's scale to fit. Same model, same answer every time. Returns the moves, any view that can't fit (and why), and a preview_token for bim_auto_layout_sheet.",
      inputSchema: { ...target, ...layoutInput },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        return await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          const sheetId = findSheet(model, args.sheet);
          if (!sheetId) return failure(`No sheet "${args.sheet}". List views and sheets first.`);
          const { layout, command } = sheetLayoutCommand(model, sheetId, layoutOptions(model, args));
          if (!command) return text({ status: "nothing_to_move", ...layoutReport(model, layout) });
          const preview = previewDocumentEdit(model, args.model_id, command);
          return text({ ...layoutReport(model, layout), status: preview.status, ...(preview.status === "would_save" ? { preview_token: preview.preview_token } : { message: preview.message }) });
        });
      } catch (err) {
        return explain(err, "bim_preview_sheet_layout");
      }
    },
  );

  server.registerTool(
    "bim_auto_layout_sheet",
    {
      title: "Lay out a sheet",
      description:
        "Apply the layout bim_preview_sheet_layout returned, as one edit: same arguments, its base_revision and preview_token. Refused if the model changed since the preview (the layout would differ): preview again.",
      inputSchema: { ...target, ...layoutInput, ...requiredBase },
    },
    async (args, extra) => {
      try {
        const who = await caller(extra, args.project_id, false);
        const built = await withSession(who, args.model_id, undefined, async (s) => {
          const model = s.model();
          if (model.revision !== args.base_revision) return `The model is at Rev ${model.revision}, not Rev ${args.base_revision} where the layout was previewed. Preview the layout again.`;
          const sheetId = findSheet(model, args.sheet);
          if (!sheetId) return `No sheet "${args.sheet}". List views and sheets first.`;
          const { command } = sheetLayoutCommand(model, sheetId, layoutOptions(model, args));
          if (!command) return "Nothing to move on this sheet.";
          const stale = previewTokenProblem({ modelId: args.model_id, branchId: previewBranchOf(model), command, revision: model.revision, token: args.preview_token, otherwise: "This isn't the layout that was previewed. Preview it again with the same arguments." });
          if (stale) return stale;
          return command;
        });
        if (typeof built === "string") return failure(built);
        return runEdit(caller, "bim_auto_layout_sheet", extra, args, built, { model_id: args.model_id, preview_token: args.preview_token });
      } catch (err) {
        return explain(err, "bim_auto_layout_sheet");
      }
    },
  );

  // ── Print and issue the set ────────────────────────────────────────────────
  // The same path as Views & Sheets › Print set and Issue set (./set-printing).

  const setContext = async (extra: Extra, projectId: string, modelId: string, write: boolean) => {
    const who = await caller(extra, projectId, write);
    const ctx: DrawingSetContext = {
      extra,
      who,
      projectId,
      modelId,
      files: setFiles(extra, projectId),
      title: await agentSheetTitle(sheetTitle, extra, projectId),
      backgrounds,
      images: sheetImages(extra, projectId),
      byName: who.agentName,
      renderer: "mutinybim-mcp",
      noteFontsDir: NOTE_FONTS_DIR,
      blockSnapshots: await blockSnapshots(extra, projectId),
      ...(write && stores.verify ? { verify: await stores.verify(extra, projectId) } : {}),
    };
    const open: OpenSession = (work) => withSession(who, modelId, undefined, work);
    return { ctx, open };
  };

  server.registerTool(
    "bim_print_set_pdf",
    {
      title: "Print the drawing set to one PDF",
      description:
        "Draw sheets from the last saved revision to one vector PDF (a page per sheet, true scale, binding order G, A, M, P, E… then number, or the order given); returns each sheet's page, the revision, sha256 and a 5-minute link. Records the print for bim_issue_set; print_notes as bim_print_sheet_pdf. Does not issue.",
      inputSchema: { ...target, sheets: z.array(sheetRef).max(300).optional().describe("Sheet numbers or ids in print order; absent: every sheet."), title: z.string().trim().min(1).max(160).optional() },
    },
    async (args, extra) => {
      try {
        const { ctx, open } = await setContext(extra, args.project_id, args.model_id, false);
        const printed = await printDrawingSet(ctx, open, { ...(args.sheets ? { sheets: args.sheets } : {}), ...(args.title ? { title: args.title } : {}) });
        if (printed.status === "refused") return failure(printed.message);
        return text({
          status: "printed",
          message: `Printed ${printed.sheets.length} sheet${printed.sheets.length === 1 ? "" : "s"} from saved Rev ${printed.revision} to one PDF. The link works for ${Math.round(printed.expiresInSeconds / 60)} minutes.`,
          revision: printed.revision,
          sheets: printed.sheets,
          sha256: printed.sha256,
          bytes: printed.bytes,
          download_url: printed.downloadUrl,
          ...(printed.titleBlockNote ? { title_block_note: printed.titleBlockNote } : {}),
          ...(printed.backgroundsMissing.length > 0 ? { backgrounds_missing: printed.backgroundsMissing } : {}),
          ...(printed.printNotes.length > 0 ? { print_notes: printed.printNotes } : {}),
        });
      } catch (err) {
        return explain(err, "bim_print_set_pdf");
      }
    },
  );

  server.registerTool(
    "bim_issue_set",
    {
      title: "Issue the drawing set",
      description:
        "Issue sheets: one edit adds add_revision to each sheet, the model is captured, the set drawn only from the capture, stored write-once and filed in the project Workspace. Nothing is issued if anything saved since expected_revision, the revision exists, or a sheet draws differently than in the last bim_print_set_pdf (live schedules; print and check again, or accept_changes_since_print once checked). Retry-safe.",
      inputSchema: {
        ...target,
        name: z.string().trim().min(1).max(120).describe("What the issue is, e.g. Issued for permit."),
        expected_revision: z.number().int().min(0).describe("The revision you checked the set at."),
        sheets: z.array(sheetRef).max(300).optional().describe("Sheet numbers or ids; absent: every sheet."),
        add_revision: revisionInput.optional(),
        accept_changes_since_print: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const { ctx, open } = await setContext(extra, args.project_id, args.model_id, true);
        // C10: a sheet whose approval was checked against an older rule is issued again only after its signer re-checks or overrides.
        const codeBlock = await open(async (sess) => issueCheck(extra, ctx.projectId, ctx.modelId, sess.model(), args.sheets));
        if (codeBlock) return failure(codeBlock);
        const result = await issueDrawingSetFor(ctx, open, {
          name: args.name,
          expectedRevision: args.expected_revision,
          ...(args.sheets ? { sheets: args.sheets } : {}),
          ...(args.add_revision ? { addRevision: args.add_revision } : {}),
          ...(args.accept_changes_since_print !== undefined ? { acceptChangesSincePrint: args.accept_changes_since_print } : {}),
        });
        switch (result.status) {
          case "refused":
            return failure(result.message);
          case "not_saved":
            return text({ ...result.edit, status: result.edit.status, message: result.message });
          case "needs_print":
            return text({ status: "needs_print", message: result.message, revision: result.revision, changed_since_print: result.comparison.status === "matches_print" ? [] : result.comparison.changed, not_in_print: result.comparison.status === "matches_print" ? [] : result.comparison.unprinted, printed_at_revision: result.comparison.printedRevision });
          default:
            return text({
              status: result.status,
              message: result.message,
              issue_id: result.issueId,
              revision: result.revision,
              snapshot_sha256: result.snapshotSha256,
              pdf_sha256: result.pdfSha256,
              sheets: result.sheets,
              references: result.references,
              print_check: result.comparison.status,
              ...(result.acceptedChangesSincePrint ? { accepted_changes_since_print: true } : {}),
              filed: result.filed,
              download_url: result.downloadUrl,
              manifest_url: result.manifestUrl,
            });
        }
      } catch (err) {
        return explain(err, "bim_issue_set");
      }
    },
  );

  server.registerTool(
    "bim_set_issue_status",
    {
      title: "Check a set before issuing",
      description: "Read only, issues nothing: whether every sheet draws as in the last set print (and which differ or weren't printed), the revision to pass bim_issue_set as expected_revision, the next revision number, the last print, earlier issues (newest first, with 5-minute PDF links), and each live block: Live, Matches or Changed since its last issue.",
      inputSchema: { ...target, sheets: z.array(sheetRef).max(300).optional().describe("Sheet numbers or ids; absent: every sheet.") },
    },
    async (args, extra) => {
      try {
        const { ctx, open } = await setContext(extra, args.project_id, args.model_id, false);
        const check = await checkDrawingSetIssue(ctx, open, args.sheets ? { sheets: args.sheets } : {});
        if (check.status !== "ready") return failure(check.message);
        const history = await drawingSetHistory(ctx);
        const differs = check.comparison.status === "matches_print" ? null : check.comparison;
        const store = ctx.blockSnapshots;
        const blocks = store
          ? await open(async (sess) => {
              const model = sess.model();
              const ids = blockSheetIds(model, args.sheets);
              return ids.length > 0 ? sheetBlockReport(model, ids, store, args.project_id, args.model_id) : [];
            })
          : [];
        return text({
          print_check: check.comparison.status,
          message: check.message,
          ...(differs ? { changed_since_print: differs.changed, not_in_print: differs.unprinted } : {}),
          revision: check.revision,
          next_revision: check.nextRevision,
          sheets: check.sheets,
          last_print: history.lastPrint,
          issues: history.issues,
          ...(blocks.length > 0 ? { blocks: blocks.map((b) => ({ id: b.blockId, title: b.title, freshness: b.label, text: b.text, ...(b.issuedText !== null ? { issued_text: b.issuedText } : {}), ...(b.unresolved.length > 0 ? { unresolved: b.unresolved } : {}) })) } : {}),
        });
      } catch (err) {
        return explain(err, "bim_set_issue_status");
      }
    },
  );
}
