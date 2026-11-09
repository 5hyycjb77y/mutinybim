import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSheetScene, canonicalJson, type ModelState, type SheetDefinition } from "@permitzip/bim-kernel";
import { modelPrintOptions, renderSheetPdf } from "./pdf";

export interface IssueManifest {
  readonly issueId: string;
  readonly modelId: string;
  readonly modelRevision: number;
  readonly snapshotSha256: string;
  readonly sheetNumber: string;
  readonly pdfFile: string;
  readonly pdfSha256: string;
  readonly embeddedDetails: ReadonlyArray<{ readonly file: string; readonly sha256: string }>;
  /** Linked references drawn under the model: the source file each plan was cut from. */
  readonly references: ReadonlyArray<{ readonly id: string; readonly file: string; readonly sha256: string }>;
  /** PDF standard-14 fonts: referenced by name, not embedded, so no font file to hash. */
  readonly fonts: readonly string[];
  readonly renderer: string;
  readonly capturedAt: string;
  readonly renderedAt: string;
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Write-once: refuse to overwrite an existing artifact. */
async function writeOnce(file: string, data: string | Uint8Array): Promise<void> {
  await writeFile(file, data, { flag: "wx" });
}

/**
 * Step 1 of issuance: capture the complete model at one revision into an
 * immutable, content-addressed snapshot file. Editing can continue afterwards.
 */
export async function captureSnapshot(outDir: string, model: ModelState): Promise<{ file: string; sha256: string }> {
  await mkdir(outDir, { recursive: true });
  const canonical = canonicalJson(model);
  const digest = sha256(canonical);
  const file = path.join(outDir, `snapshot-${digest}.json`);
  try {
    await writeOnce(file, canonical);
  } catch (err) {
    // Same content already captured (same hash) is fine; anything else is a real failure.
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  }
  return { file, sha256: digest };
}

/**
 * Step 2: render ONLY from the stored snapshot file (never live state), store
 * the PDF write-once, and write the manifest last.
 */
export async function issueFromSnapshot(
  outDir: string,
  snapshotFile: string,
  sheet: SheetDefinition,
  renderer: string,
  capturedAt: string,
): Promise<IssueManifest> {
  const canonical = await readFile(snapshotFile, "utf8");
  const snapshotSha256 = sha256(canonical);
  const model: ModelState = JSON.parse(canonical);
  const scene = buildSheetScene(model, sheet);
  const pdf = await renderSheetPdf(scene, {
    title: `${sheet.number} ${sheet.title}`,
    modelRevision: model.revision,
    snapshotSha256,
    renderer,
  }, undefined, null, modelPrintOptions(model));
  const issueId = randomUUID();
  const pdfFile = `${sheet.number}-rev${model.revision}-${issueId.slice(0, 8)}.pdf`;
  await writeOnce(path.join(outDir, pdfFile), pdf.bytes);
  const manifest: IssueManifest = {
    issueId,
    modelId: model.modelId,
    modelRevision: model.revision,
    snapshotSha256,
    sheetNumber: sheet.number,
    pdfFile,
    pdfSha256: sha256(pdf.bytes),
    embeddedDetails: pdf.embeddedDetails,
    references: (sheet.references ?? []).map((r) => ({ id: r.plan.id, file: r.plan.source.file, sha256: r.plan.source.sha256 })),
    fonts: ["Helvetica", "Helvetica-Bold"],
    renderer,
    capturedAt,
    renderedAt: new Date().toISOString(),
  };
  await writeOnce(path.join(outDir, `${issueId}.manifest.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}
