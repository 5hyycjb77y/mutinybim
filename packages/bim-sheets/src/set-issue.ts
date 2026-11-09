import { createHash } from "node:crypto";
import { NOTE_FONT_FACES, NOTE_FONT_FILES, buildSheetSceneFor, documentIndex, setOrder, sheetViewports, type ModelState, type Sheet, type SheetDrawOptions, type SheetRevision, type ViewBackgrounds } from "@permitzip/bim-kernel";
import { modelPrintOptions, renderSheetPdf, type NoteFontSource, type SheetImageSource } from "./pdf";
import { mergeSheetPdfs, stampSheetCode, type RenderedSet } from "./set-pdf";
import { sheetPrintNotes } from "./print-notes";

export { setOrder };

/**
 * Printing and issuing a whole drawing set from one model snapshot. Issue
 * renders only from the captured snapshot text (never live state), so the
 * PDF, its hash and the manifest describe exactly one revision. Storage is the
 * caller's: this module returns bytes and the manifest, write-once is theirs.
 */

/** The sheets to print: the named ones (id or number) in the order given, or every sheet in binding order. */
export function resolveSetSheets(model: ModelState, wanted: readonly string[] | undefined): { sheets: Sheet[]; missing: string[] } {
  const all = documentIndex(model).sheets;
  if (!wanted || wanted.length === 0) return { sheets: setOrder(all), missing: [] };
  const sheets: Sheet[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    const key = w.trim().toLowerCase();
    const found = all.find((s) => s.id === w || s.number.trim().toLowerCase() === key);
    if (found && !sheets.includes(found)) sheets.push(found);
    else if (!found) missing.push(w);
  }
  return { sheets, missing };
}

export interface SetSheetEntry {
  readonly number: string;
  readonly title: string;
  readonly page: number;
  readonly revisions: readonly SheetRevision[];
  readonly views: readonly string[];
}

export interface RenderedDrawingSet {
  readonly pdf: RenderedSet;
  readonly sheets: readonly SetSheetEntry[];
  /** Linked models the printed views show, by id, with the views that show them. */
  readonly references: ReadonlyArray<{ readonly id: string; readonly views: readonly string[] }>;
  /** Per sheet, what printed differently from the screen or off its drawing area (`sheetPrintNotes`); not part of an issue's manifest. */
  readonly printNotes: readonly string[];
  /** V10: each sheet's own PDF, exactly as it was copied into the set (with its Verify code when it has one). */
  readonly sheetPdfs: readonly RenderedSheetPdf[];
}

/** V10: one sheet's own PDF in a rendered set. */
export interface RenderedSheetPdf {
  readonly sheetId: string;
  readonly number: string;
  readonly title: string;
  readonly bytes: Uint8Array;
}

export interface RenderSetOptions {
  readonly sheets?: readonly string[];
  /** Title-block fallbacks; a sheet's own project_name / project_number / firm_name fields win. */
  readonly projectName: string;
  readonly projectNumber?: string;
  readonly firmName?: string;
  /** Linked-model backgrounds by view id, cut the way the Building Model cuts them for its sheets. */
  readonly backgrounds?: ViewBackgrounds;
  readonly title: string;
  readonly renderer: string;
  readonly snapshotSha256: string;
  readonly noteFonts: NoteFontSource;
  /** Loads placed pictures; a set with a picture and no source is refused in words. */
  readonly images?: SheetImageSource;
  /** V10: the Verify link to print as a QR code on each sheet, by sheet id. Sheets without one print no code. */
  readonly sheetCodes?: Readonly<Record<string, string>>;
}

/** How every sheet of a set draws: the title-block fallbacks and the linked backgrounds. */
export function setDrawOptions(opts: Pick<RenderSetOptions, "projectName" | "projectNumber" | "firmName" | "backgrounds">): SheetDrawOptions {
  return {
    projectName: opts.projectName,
    ...(opts.projectNumber ? { projectNumber: opts.projectNumber } : {}),
    ...(opts.firmName ? { firmName: opts.firmName } : {}),
    ...(opts.backgrounds ? { backgrounds: opts.backgrounds } : {}),
  };
}

/** Render a set from a model state. Throws with a plain reason when a named sheet doesn't exist. */
export async function renderDrawingSet(model: ModelState, opts: RenderSetOptions): Promise<RenderedDrawingSet> {
  const { sheets, missing } = resolveSetSheets(model, opts.sheets);
  if (missing.length > 0) throw new Error(`No sheet ${missing.map((m) => `"${m}"`).join(", ")} in this model. List views and sheets first.`);
  if (sheets.length === 0) throw new Error("This model has no sheets to print yet.");
  const pages = [];
  const references = new Map<string, Set<string>>();
  const entries: Omit<SetSheetEntry, "page">[] = [];
  const printNotes: string[] = [];
  const sheetPdfs: RenderedSheetPdf[] = [];
  for (const sheet of sheets) {
    const scene = buildSheetSceneFor(model, sheet.id, setDrawOptions(opts));
    const rendered = await renderSheetPdf(scene, { title: `${sheet.number} ${sheet.title}`, modelRevision: model.revision, snapshotSha256: opts.snapshotSha256, renderer: opts.renderer }, opts.noteFonts, opts.images ?? null, modelPrintOptions(model));
    // V10: the sheet's Verify code is drawn into its own PDF before it joins the set.
    const code = opts.sheetCodes?.[String(sheet.id)];
    const bytes = code ? await stampSheetCode(rendered.bytes, code) : rendered.bytes;
    pages.push({ number: sheet.number, title: sheet.title, bytes });
    sheetPdfs.push({ sheetId: String(sheet.id), number: sheet.number, title: sheet.title, bytes });
    printNotes.push(...sheetPrintNotes(model, sheet.id, sheet.number, rendered));
    const views: string[] = [];
    for (const { view } of sheetViewports(model, sheet)) {
      views.push(view.name);
      for (const [id, display] of Object.entries(view.props?.references ?? {})) {
        if (!display.visible) continue;
        references.set(id, (references.get(id) ?? new Set<string>()).add(view.name));
      }
    }
    entries.push({ number: sheet.number, title: sheet.title, revisions: sheet.props?.revisions ?? [], views });
  }
  const pdf = await mergeSheetPdfs(pages, { title: opts.title, modelRevision: model.revision, snapshotSha256: opts.snapshotSha256, renderer: opts.renderer });
  return {
    pdf,
    sheets: entries.map((e, i) => ({ ...e, page: pdf.pages[i]?.page ?? i + 1 })),
    references: [...references].map(([id, views]) => ({ id, views: [...views].sort() })),
    printNotes,
    sheetPdfs,
  };
}

export interface SetIssueManifest {
  readonly issueId: string;
  readonly kind: "drawing_set";
  readonly name: string;
  readonly modelId: string;
  readonly modelRevision: number;
  readonly snapshotSha256: string;
  readonly snapshotFile: string;
  readonly pdfFile: string;
  readonly pdfSha256: string;
  readonly sheets: readonly SetSheetEntry[];
  readonly references: RenderedDrawingSet["references"];
  /** Standard-14 faces are referenced by name; the note faces are embedded and pinned by hash. */
  readonly fonts: ReadonlyArray<{ readonly name: string; readonly sha256: string | null }>;
  readonly renderer: string;
  readonly issuedBy: string;
  readonly capturedAt: string;
  readonly renderedAt: string;
  /** V10: each sheet's own file and its fingerprint; absent on sets issued before round 10. */
  readonly sheetFiles?: ReadonlyArray<{ readonly sheetId: string; readonly number: string; readonly file: string; readonly sha256: string }>;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface IssuedSetFiles {
  readonly snapshot: { readonly name: string; readonly text: string; readonly sha256: string };
  readonly pdf: { readonly name: string; readonly bytes: Uint8Array; readonly sha256: string };
  readonly manifest: SetIssueManifest;
  /** V10: each sheet's own PDF, the files "Verify a PDF" recognises one by one. */
  readonly sheetFiles: readonly IssuedSheetFile[];
}

// ---------------------------------------------------------------------------
// V10 — per-sheet fingerprints: each issued sheet's own PDF (with its Verify
// code) is a file of its own with its own SHA-256, so "this exact file is
// sheet A-101 of the set issued Nov 3" is answerable for the files handed out.
// A sheet split out of the merged set by another PDF tool has other bytes and
// honestly doesn't match.
// ---------------------------------------------------------------------------

export interface IssuedSheetFile {
  readonly sheetId: string;
  readonly number: string;
  readonly title: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

const fileSafe = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "sheet";

/** Name and fingerprint each sheet's own PDF of an issue. */
export function issuedSheetFiles(sheetPdfs: readonly RenderedSheetPdf[], issueId: string): IssuedSheetFile[] {
  return sheetPdfs.map((p) => {
    const digest = sha256(p.bytes);
    return { sheetId: p.sheetId, number: p.number, title: p.title, name: `sheet-${fileSafe(p.number)}-${issueId.slice(0, 8)}-${digest.slice(0, 12)}.pdf`, bytes: p.bytes, sha256: digest };
  });
}

export { reissueCheck, type BlockedApproval, type ReissueCheck, type SheetApproval } from "./reissue-check";

/**
 * Issue a set: render only from the snapshot text (parsed here), and describe
 * the result. The caller stores the snapshot, then the PDF, then the manifest,
 * each write-once.
 */
export async function issueDrawingSet(
  snapshotText: string,
  opts: Omit<RenderSetOptions, "snapshotSha256"> & { readonly issueId: string; readonly name: string; readonly issuedBy: string; readonly capturedAt: string },
): Promise<IssuedSetFiles> {
  const snapshotSha256 = sha256(snapshotText);
  const model: ModelState = JSON.parse(snapshotText);
  const set = await renderDrawingSet(model, { ...opts, snapshotSha256 });
  const pdfSha256 = sha256(set.pdf.bytes);
  const pdfName = `set-rev${model.revision}-${opts.issueId.slice(0, 8)}.pdf`;
  const snapshotName = `snapshot-${snapshotSha256}.json`;
  const sheetFiles = issuedSheetFiles(set.sheetPdfs, opts.issueId);
  return {
    snapshot: { name: snapshotName, text: snapshotText, sha256: snapshotSha256 },
    pdf: { name: pdfName, bytes: set.pdf.bytes, sha256: pdfSha256 },
    manifest: {
      issueId: opts.issueId,
      kind: "drawing_set",
      name: opts.name,
      modelId: model.modelId,
      modelRevision: model.revision,
      snapshotSha256,
      snapshotFile: snapshotName,
      pdfFile: pdfName,
      pdfSha256,
      sheets: set.sheets,
      references: set.references,
      fonts: [
        { name: "Helvetica", sha256: null },
        { name: "Helvetica-Bold", sha256: null },
        ...(["regular", "bold", "italic", "boldItalic"] as const).map((face) => ({ name: NOTE_FONT_FILES[face], sha256: NOTE_FONT_FACES[face].sha256 })),
      ],
      renderer: opts.renderer,
      issuedBy: opts.issuedBy,
      capturedAt: opts.capturedAt,
      renderedAt: new Date().toISOString(),
      sheetFiles: sheetFiles.map((f) => ({ sheetId: f.sheetId, number: f.number, file: `sheets/${f.name}`, sha256: f.sha256 })),
    },
    sheetFiles,
  };
}
