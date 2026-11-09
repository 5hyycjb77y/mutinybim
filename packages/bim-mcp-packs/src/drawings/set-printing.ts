import { createHash } from "node:crypto";
import { ensureBimChartKinds } from "@permitzip/bim-editor/contracts/bim/chart-kinds";
import { z } from "zod";
import { canonicalJson, sheetViewports, type ModelState, type Sheet, type SheetRevision, type ViewElement } from "@permitzip/bim-kernel";
import {
  compareWithPrint,
  describePrintComparison,
  issueDrawingSet,
  nodeNoteFonts,
  renderDrawingSet,
  resolveSetSheets,
  blockSnapshotsAt,
  setDrawOptions,
  sheetBlockValues,
  sheetDigests,
  type PrintComparison,
  type SetPrintRecord,
  type SheetImageSource,
} from "@permitzip/bim-sheets";
import type { AgentSession } from "@permitzip/bim-sync";
import { addRevisionCommand, nextRevisionNumber, sheetWithRevision } from "@permitzip/bim-editor/contracts/building-model/sheet-commands";
import { issueSummarySchema, type IssueCheckResult, type IssueSetInput, type IssueSetResult, type IssueSummary, type PrintSetResult, type SetHistory } from "@permitzip/bim-editor/contracts/bim/drawing-set-results";
import { issueHoldsForSheets } from "@permitzip/bim-kernel/questions";
import { editIdempotencyKey, type BimCaller, type Extra } from "../runtime";
import type { AgentSheetTitle } from "../views/sheet-title";
import type { BlockSnapshotStore } from "./block-snapshots";
import type { DrawingSetFiles, IssuedSheetRecorder, LinkedBackgroundsFor } from "./capabilities";

/**
 * Printing and issuing a drawing set: the one command path behind the
 * Views & Sheets "Print set" and "Issue set" dialogs and the agent's
 * bim_print_set_pdf / bim_issue_set. Everything reads the saved model from
 * the model server as the caller, so a person and an agent get the same
 * pages, the same checks and the same refusals.
 *
 * A set print records how every sheet drew. Issuing compares the sheets as
 * they draw now with that print (schedules, tags and title fields are live
 * and can change without anyone touching the sheet), refuses while they
 * differ unless the caller accepts the changes, then re-renders the issue
 * from one captured snapshot, so the issued PDF is exactly that snapshot.
 */

export interface DrawingSetContext {
  readonly extra: Extra;
  readonly who: Pick<BimCaller, "userId" | "runId">;
  readonly projectId: string;
  readonly modelId: string;
  readonly files: DrawingSetFiles;
  readonly title: AgentSheetTitle;
  readonly backgrounds: LinkedBackgroundsFor;
  /** Pictures placed on the sheets. */
  readonly images: SheetImageSource;
  /** The caller in words, for "last printed by". */
  readonly byName: string;
  /** "mutinybim-mcp" for agents, "mutinybim-web" for people. */
  readonly renderer: string;
  readonly noteFontsDir: string;
  /** Where issue snapshots of live blocks go. Absent: sheets with a live block refuse to issue. */
  readonly blockSnapshots?: BlockSnapshotStore;
  /** V10: where each issued sheet's QR token and fingerprint are recorded. Absent: sheets print no Verify code. */
  readonly verify?: IssuedSheetRecorder;
}

export type { IssueCheckResult, IssueSetInput, IssueSetResult, IssueSheetSummary, IssueSummary, PrintSetResult, SetHistory, SetSheetPage } from "@permitzip/bim-editor/contracts/bim/drawing-set-results";

export type OpenSession = <T>(work: (session: AgentSession) => Promise<T>) => Promise<T>;

ensureBimChartKinds();

const printRecordSchema = z.object({
  kind: z.literal("set_print"),
  modelId: z.string(),
  modelRevision: z.number(),
  pdfFile: z.string(),
  pdfSha256: z.string(),
  sheets: z.array(z.object({ sheetId: z.string(), number: z.string(), digest: z.string() })),
  printedBy: z.string(),
  printedByName: z.string().optional(),
  printedAt: z.string(),
});

/** Records kept per model; the newest few answer "last print" and "earlier issues". */
const PRINT_RECORDS_READ = 20; // newest first: only the latest JSON record is used
const ISSUES_SHOWN = 20; // the issue history a person or agent sees (newest first)

const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "model";
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const enc = new TextEncoder();
const dec = new TextDecoder();

function paths(ctx: Pick<DrawingSetContext, "projectId" | "modelId">) {
  const base = `projects/${ctx.projectId}/building-model`;
  const model = `${base}/sets/${safeSegment(ctx.modelId)}`;
  return { base, prints: `${model}/prints`, issues: `${model}/issues` };
}

function viewsOn(model: ModelState, sheets: readonly Sheet[]): ViewElement[] {
  return sheets.flatMap((sheet) => sheetViewports(model, sheet).map(({ view }) => view));
}

async function drawOptions(ctx: DrawingSetContext, model: ModelState, sheets: readonly Sheet[]) {
  const { backgrounds, missing } = await ctx.backgrounds(ctx.extra, ctx.projectId, model, viewsOn(model, sheets));
  const opts = { projectName: ctx.title.projectName, projectNumber: ctx.title.projectNumber, firmName: ctx.title.firmName, backgrounds };
  return { opts, missing };
}

export async function latestSetPrint(ctx: Pick<DrawingSetContext, "projectId" | "modelId" | "files">): Promise<SetPrintRecord | null> {
  const folder = paths(ctx).prints;
  const listed = await ctx.files.list(folder, PRINT_RECORDS_READ);
  const newest = listed.find((f) => f.name.endsWith(".json"));
  if (!newest) return null;
  const bytes = await ctx.files.read(`${folder}/${newest.name}`);
  if (!bytes) return null;
  const parsed = printRecordSchema.safeParse(JSON.parse(dec.decode(bytes)));
  if (!parsed.success) throw new Error(`The last set print record (${newest.name}) can't be read: ${parsed.error.issues[0]?.message ?? "bad shape"}. Print the set again.`);
  return parsed.data;
}

/** Print sheets of the saved model to one PDF and record how each sheet drew. */
export async function printDrawingSet(ctx: DrawingSetContext, open: OpenSession, input: { readonly sheets?: readonly string[]; readonly title?: string }): Promise<PrintSetResult> {
  const drawn = await open(async (s) => {
    const model = s.model();
    const { sheets, missing } = resolveSetSheets(model, input.sheets);
    if (missing.length > 0) return `No sheet ${missing.map((m) => `"${m}"`).join(", ")} in this model. List views and sheets first.`;
    if (sheets.length === 0) return "This model has no sheets to print yet.";
    const { opts, missing: backgroundsMissing } = await drawOptions(ctx, model, sheets);
    const snapshotSha256 = sha256(canonicalJson({ modelId: model.modelId, revision: model.revision }));
    const titleText = input.title ?? `${[ctx.title.projectNumber, ctx.title.projectName].filter(Boolean).join(" ") || ctx.modelId} drawing set`;
    const set = await renderDrawingSet(model, { ...opts, sheets: sheets.map((sh) => sh.id), title: titleText, renderer: ctx.renderer, snapshotSha256, noteFonts: nodeNoteFonts(ctx.noteFontsDir), images: ctx.images });
    return { set, model, sheets, digests: sheetDigests(model, sheets.map((sh) => sh.id), setDrawOptions(opts)), backgroundsMissing };
  });
  if (typeof drawn === "string") return { status: "refused", message: drawn };
  const pdfSha = sha256(drawn.set.pdf.bytes);
  const printedAt = new Date().toISOString();
  const stem = `${paths(ctx).prints}/${printedAt.replace(/[:.]/g, "-")}-rev${drawn.model.revision}-${pdfSha.slice(0, 12)}`;
  const stored = await ctx.files.put(`${stem}.pdf`, drawn.set.pdf.bytes, "application/pdf");
  const record: SetPrintRecord = {
    kind: "set_print",
    modelId: ctx.modelId,
    modelRevision: drawn.model.revision,
    pdfFile: `${stem}.pdf`,
    pdfSha256: pdfSha,
    sheets: drawn.digests,
    printedBy: ctx.who.userId,
    printedByName: ctx.byName,
    printedAt,
  };
  await ctx.files.put(`${stem}.json`, enc.encode(JSON.stringify(record, null, 2)), "application/json");
  return {
    status: "printed",
    revision: drawn.model.revision,
    sheets: drawn.set.sheets.map((p) => ({ number: p.number, title: p.title, page: p.page })),
    sha256: pdfSha,
    bytes: drawn.set.pdf.bytes.byteLength,
    downloadUrl: stored.downloadUrl,
    expiresInSeconds: stored.expiresInSeconds,
    ...(ctx.title.note ? { titleBlockNote: ctx.title.note } : {}),
    backgroundsMissing: drawn.backgroundsMissing,
    printNotes: drawn.set.printNotes,
  };
}

/** The sheets as they draw now against the last set print. */
async function printCheck(ctx: DrawingSetContext, model: ModelState, sheets: readonly Sheet[]): Promise<PrintComparison> {
  const { opts } = await drawOptions(ctx, model, sheets);
  return compareWithPrint(sheetDigests(model, sheets.map((sh) => sh.id), setDrawOptions(opts)), await latestSetPrint(ctx));
}

/** What issuing these sheets now would find, without issuing: the print check, the revision, the next revision number. */
export async function checkDrawingSetIssue(ctx: DrawingSetContext, open: OpenSession, input: { readonly sheets?: readonly string[] }): Promise<IssueCheckResult> {
  return open(async (s) => {
    const model = s.model();
    const { sheets, missing } = resolveSetSheets(model, input.sheets);
    if (missing.length > 0) return { status: "refused", message: `No sheet ${missing.map((m) => `"${m}"`).join(", ")}. List views and sheets first.` };
    if (sheets.length === 0) return { status: "refused", message: "This model has no sheets to issue yet." };
    const held = issueHoldsForSheets(model, sheets.map((sh) => sh.id));
    if (held.message) return { status: "refused", message: held.message };
    const comparison = await printCheck(ctx, model, sheets);
    return {
      status: "ready",
      message: describePrintComparison(comparison),
      revision: model.revision,
      comparison,
      sheets: sheets.map((sh) => ({ number: sh.number, title: sh.title, lastRevision: sh.props?.revisions?.[sh.props.revisions.length - 1]?.number ?? null })),
      nextRevision: nextRevisionNumber(sheets),
    };
  });
}

/** A stable issue id from the request, so a retried issue writes nothing new. */
function issueIdFor(ctx: DrawingSetContext, input: IssueSetInput, sheetIds: readonly string[], revision: number): string {
  const request = { name: input.name, sheets: sheetIds, addRevision: input.addRevision ?? null };
  const h = sha256(canonicalJson({ who: ctx.who.runId, project: ctx.projectId, model: ctx.modelId, request, revision }));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const sameRow = (a: SheetRevision | undefined, b: SheetRevision | undefined) => Boolean(a && b && canonicalJson(a) === canonicalJson(b));

/**
 * Issue sheets as a set. Checks, in order: the sheets exist; nothing was saved
 * since the caller checked the set (expected revision); the revision number
 * is new; every sheet draws as it did in the last set print (unless the
 * caller accepts the changes). Then one edit adds the revision row, the
 * model is captured, and the set renders only from that capture.
 */
export async function issueDrawingSetFor(ctx: DrawingSetContext, open: OpenSession, input: IssueSetInput): Promise<IssueSetResult> {
  return open(async (s) => {
    let model = s.model();
    const { sheets, missing } = resolveSetSheets(model, input.sheets);
    if (missing.length > 0) return { status: "refused", message: `No sheet ${missing.map((m) => `"${m}"`).join(", ")}. List views and sheets first.` };
    if (sheets.length === 0) return { status: "refused", message: "This model has no sheets to issue." };
    const held = issueHoldsForSheets(model, sheets.map((sh) => sh.id));
    if (held.message) return { status: "refused", message: held.message };
    const store = ctx.blockSnapshots;
    if (!store) {
      const live = sheetBlockValues(model, sheets.map((sh) => sh.id));
      if (live.length > 0) {
        const on = [...new Set(live.map((v) => sheets.find((sh) => sh.id === v.sheetId)?.number ?? v.sheetId))].join(", ");
        return { status: "refused", message: `Not issued: ${on} ${live.length === 1 ? "has a live block" : `has ${live.length} live blocks`} (load summary), and this way of issuing can't record what ${live.length === 1 ? "it" : "they"} said at issue, so "Changed since" would be wrong later. Issue from the Building Model (Views & Sheets › Issue set).` };
      }
    }
    const row = input.addRevision;
    // A retry after the revision rows saved: every sheet already ends with exactly this row.
    const rowsAlreadyAdded = Boolean(row) && sheets.every((sh) => sameRow(sh.props?.revisions?.[sh.props.revisions.length - 1], row));
    if (model.revision !== input.expectedRevision && !rowsAlreadyAdded) {
      return { status: "refused", message: `Not issued: the model is at Rev ${model.revision}, but the set was checked at Rev ${input.expectedRevision}. Someone saved changes since; review them, print again, then issue at the new revision.` };
    }
    if (row && !rowsAlreadyAdded) {
      const clash = sheetWithRevision(sheets, row.number);
      if (clash) return { status: "refused", message: `Not issued: sheet ${clash.number} already has revision ${row.number}. Use the next revision number (${nextRevisionNumber(sheets)}).` };
    }

    const comparison = await printCheck(ctx, model, sheets);
    const accepted = comparison.status !== "matches_print" && input.acceptChangesSincePrint === true;
    if (comparison.status !== "matches_print" && !accepted && !rowsAlreadyAdded) {
      return { status: "needs_print", message: `Not issued: ${describePrintComparison(comparison)} To issue anyway, confirm you've checked these sheets.`, revision: model.revision, comparison };
    }

    if (row) {
      // Keyed by the request, not the rows it computes, so a retry gets the first answer.
      const idempotencyKey = editIdempotencyKey(ctx.who.runId, "bim_issue_set", { model_id: ctx.modelId, sheets: sheets.map((sh) => sh.id), revision: row }, input.expectedRevision);
      const command = rowsAlreadyAdded
        ? { ...addRevisionCommand(sheets, row), commands: sheets.map((sh) => ({ type: "set_sheet_properties" as const, sheetId: sh.id, revisions: sh.props?.revisions ?? [] })) }
        : addRevisionCommand(sheets, row);
      const result = await s.edit(command, { idempotencyKey, baseRevision: input.expectedRevision });
      if (result.status !== "saved") return { status: "not_saved", message: `Not issued: the revision row wasn't saved (${result.message}).`, edit: result };
      if (result.rebased) return { status: "refused", message: `Revision ${row.number} is saved at Rev ${result.revision}, but other changes were saved after the set was checked. Review them, then issue at Rev ${result.revision} without adding a revision.` };
      model = s.model();
      if (model.revision !== result.revision) return { status: "refused", message: `Revision ${row.number} is saved at Rev ${result.revision}, but someone saved again right after (Rev ${model.revision}). Review, then issue at Rev ${model.revision} without adding a revision.` };
    }

    const issueId = issueIdFor(ctx, input, sheets.map((sh) => sh.id), model.revision);
    const issueDir = `${paths(ctx).base}/issues/${issueId}`;
    const snapshotText = canonicalJson(model);
    const captured: ModelState = JSON.parse(snapshotText);
    const issuedSheets = resolveSetSheets(captured, sheets.map((sh) => sh.id)).sheets;
    const { opts: issueOpts } = await drawOptions(ctx, captured, issuedSheets);
    const capturedAt = new Date().toISOString();
    // V10: reserve each sheet's Verify code before drawing; a retry of this issue gets the same codes.
    const sheetCodes = ctx.verify
      ? await ctx.verify.reserve({
          projectId: ctx.projectId,
          modelId: ctx.modelId,
          issueId,
          issueName: input.name,
          modelRevision: captured.revision,
          issuedAt: capturedAt,
          sheets: issuedSheets.map((sh) => ({ sheetId: String(sh.id), number: sh.number, title: sh.title, revisions: sh.props?.revisions ?? [] })),
        })
      : undefined;
    const files = await issueDrawingSet(snapshotText, {
      ...issueOpts,
      issueId,
      name: input.name,
      sheets: sheets.map((sh) => sh.id),
      title: `${input.name} - Rev ${model.revision}`,
      renderer: ctx.renderer,
      issuedBy: ctx.who.userId,
      capturedAt,
      noteFonts: nodeNoteFonts(ctx.noteFontsDir),
      images: ctx.images,
      ...(sheetCodes ? { sheetCodes } : {}),
    });
    const manifest = { ...files.manifest, printCheck: { status: comparison.status, printedRevision: comparison.printedRevision, acceptedChangesSincePrint: accepted, ...(comparison.status === "matches_print" ? {} : { changed: comparison.changed, unprinted: comparison.unprinted }) } };
    await ctx.files.put(`${issueDir}/${files.snapshot.name}`, enc.encode(files.snapshot.text), "application/json");
    const pdfPath = `${issueDir}/${files.pdf.name}`;
    const pdf = await ctx.files.put(pdfPath, files.pdf.bytes, "application/pdf");
    const stored = await ctx.files.put(`${issueDir}/manifest.json`, enc.encode(JSON.stringify(manifest, null, 2)), "application/json");
    // V10: each sheet's own PDF (the files Verify recognises), then their fingerprints, before the issue is listed.
    if (ctx.verify && sheetCodes) {
      for (const f of files.sheetFiles) await ctx.files.put(`${issueDir}/sheets/${f.name}`, f.bytes, "application/pdf");
      await ctx.verify.record({
        projectId: ctx.projectId,
        modelId: ctx.modelId,
        issueId,
        setPdfSha256: files.pdf.sha256,
        model: captured,
        sheets: files.sheetFiles.map((f) => ({ sheetId: f.sheetId, sha256: f.sha256, storagePath: `${issueDir}/sheets/${f.name}`, byteSize: f.bytes.byteLength })),
      });
    }
    // Frozen before the issue is listed, so a listed issue always has its block values; a retry fills in what's missing.
    const blockSnaps = blockSnapshotsAt(captured, issuedSheets.map((sh) => sh.id));
    if (blockSnaps.length > 0) {
      if (!store) throw new Error("Not issued: the captured sheets carry live blocks but there is nowhere to record them.");
      await store.record({ projectId: ctx.projectId, modelId: ctx.modelId, issueId, issueName: input.name }, blockSnaps);
    }
    const sheetRows = files.manifest.sheets.map((sh) => ({ number: sh.number, title: sh.title, page: sh.page, revision: sh.revisions[sh.revisions.length - 1]?.number ?? null }));
    const summary: IssueSummary = {
      issueId,
      name: input.name,
      modelRevision: files.manifest.modelRevision,
      issuedAt: files.manifest.capturedAt,
      issuedBy: ctx.who.userId,
      issuedByName: ctx.byName,
      pdfFile: pdfPath,
      sheets: sheetRows.map(({ number, title, revision }) => ({ number, title, revision })),
    };
    await ctx.files.put(`${paths(ctx).issues}/${issueId}.json`, enc.encode(JSON.stringify(summary, null, 2)), "application/json");
    const revLabel = row ? ` Rev ${row.number}` : "";
    const filed = await ctx.files.fileInProject({ storagePath: pdfPath, name: `${input.name}${revLabel} (model Rev ${files.manifest.modelRevision})`, sizeBytes: files.pdf.bytes.byteLength, sha256: files.pdf.sha256, userId: ctx.who.userId });
    const again = pdf.existed && stored.existed;
    return {
      status: again ? "already_issued" : "issued",
      message: `${again ? "Already issued" : "Issued"} "${input.name}": ${sheetRows.length} sheet${sheetRows.length === 1 ? "" : "s"} from Rev ${files.manifest.modelRevision}.${blockSnaps.length > 0 ? ` Froze ${blockSnaps.length} live block${blockSnaps.length === 1 ? "" : "s"} as issued.` : ""}${filed.status === "not_filed" ? ` ${filed.reason}` : ` In the project Workspace › ${filed.folder}.`} The link works for ${Math.round(pdf.expiresInSeconds / 60)} minutes.`,
      issueId,
      revision: files.manifest.modelRevision,
      snapshotSha256: files.manifest.snapshotSha256,
      pdfSha256: files.manifest.pdfSha256,
      sheets: sheetRows,
      references: files.manifest.references,
      downloadUrl: pdf.downloadUrl,
      manifestUrl: stored.downloadUrl,
      filed,
      comparison,
      acceptedChangesSincePrint: accepted,
      blocksFrozen: blockSnaps.length,
      verifyLinks: sheetCodes ? files.sheetFiles.map((f) => ({ number: f.number, url: sheetCodes[f.sheetId] ?? "" })).filter((l) => l.url !== "") : [],
    };
  });
}

/** The last set print and earlier issues of a model, newest first, with fresh download links. */
export async function drawingSetHistory(ctx: Pick<DrawingSetContext, "projectId" | "modelId" | "files">): Promise<SetHistory> {
  const print = await latestSetPrint(ctx);
  const folder = paths(ctx).issues;
  const listed = (await ctx.files.list(folder, ISSUES_SHOWN)).filter((f) => f.name.endsWith(".json"));
  const issues: Array<IssueSummary & { downloadUrl: string }> = [];
  for (const f of listed) {
    const bytes = await ctx.files.read(`${folder}/${f.name}`);
    if (!bytes) continue;
    const parsed = issueSummarySchema.safeParse(JSON.parse(dec.decode(bytes)));
    if (!parsed.success) {
      console.error("[drawing-set] an issue summary couldn't be read; leaving it out of the history", { file: f.name, issue: parsed.error.issues[0] });
      continue;
    }
    issues.push({ ...parsed.data, downloadUrl: (await ctx.files.link(parsed.data.pdfFile)).downloadUrl });
  }
  issues.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  return {
    lastPrint: print
      ? { modelRevision: print.modelRevision, printedAt: print.printedAt, ...(print.printedByName ? { printedByName: print.printedByName } : {}), sheets: print.sheets.map((sh) => sh.number), downloadUrl: (await ctx.files.link(print.pdfFile)).downloadUrl }
      : null,
    issues,
  };
}
