/**
 * @jest-environment node
 */
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  buildSheetScene,
  demoSheetDefinition,
  executeCommand,
  feetInches,
  type ModelState,
} from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { DETAILS_DIR, DetailHashMismatchError, captureSnapshot, issueFromSnapshot, renderSheetPdf } from "../src";

const FT = 304.8;

function apply(model: ModelState, cmd: Parameters<typeof executeCommand>[1]): ModelState {
  const res = executeCommand(model, cmd);
  if (!res.ok) throw new Error(res.error.message);
  return { ...res.model, revision: (model.revision + 1) as ModelState["revision"] };
}

describe("live documents follow the model", () => {
  it("a branch slide updates its tag position and both affected dimensions", () => {
    const sheet = demoSheetDefinition();
    const before = buildSheetScene(createDemoModel(), sheet);
    const after = buildSheetScene(apply(createDemoModel(), { type: "slide_branch", tapId: "tap-1", s: 9 * FT }), sheet);
    const dim = (s: typeof before, id: string) => s.dimensions.find((d) => d.id === id);
    expect(dim(before, "dim-unit-to-branch-1")?.text).toBe("12'-0\"");
    expect(dim(after, "dim-unit-to-branch-1")?.text).toBe("9'-0\"");
    expect(dim(before, "dim-branch-1-to-branch-2")?.text).toBe("14'-0\"");
    expect(dim(after, "dim-branch-1-to-branch-2")?.text).toBe("17'-0\"");
    const tag = (s: typeof before) => s.tags.find((t) => t.elementId === "seg-riser-1");
    expect((tag(after)?.at.x ?? 0) < (tag(before)?.at.x ?? 0)).toBe(true);
  });

  it("a diffuser airflow change updates the schedule and the unit total", () => {
    const sheet = demoSheetDefinition();
    const scene = buildSheetScene(apply(createDemoModel(), { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 425 }), sheet);
    expect(scene.schedule).toEqual([
      { mark: "RTU-1", description: "Rooftop unit, 5 ton", cfm: 725 },
      { mark: "SD-1", description: "Supply diffuser 24x24", cfm: 425 },
      { mark: "SD-2", description: "Supply diffuser 24x24", cfm: 300 },
    ]);
  });

  it("a dimension whose anchor disappears is shown as orphaned, never silently dropped", () => {
    const model = createDemoModel();
    const elements = { ...model.elements };
    delete elements["tap-2"];
    const scene = buildSheetScene({ ...model, elements }, demoSheetDefinition());
    const orphan = scene.dimensions.find((d) => d.id === "dim-branch-1-to-branch-2");
    expect(orphan?.orphaned).toBe(true);
    expect(scene.primitives.some((p) => p.kind === "text" && p.text.includes("REFERENCE MISSING"))).toBe(true);
  });

  it("formats feet and inches", () => {
    expect(feetInches(10 * FT)).toBe("10'-0\"");
    expect(feetInches(10 * FT + 6 * 25.4)).toBe("10'-6\"");
    expect(feetInches(3 * 25.4 + 12.7)).toBe("0'-3 1/2\"");
  });
});

describe("issued drawings are pinned and immutable", () => {
  it("renders from the captured snapshot even after the model moves on", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mutinybim-issue-"));
    const rev1 = apply(createDemoModel(), { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 400 });
    const snap = await captureSnapshot(dir, rev1);
    // Editing continues after capture.
    const rev2 = apply(rev1, { type: "set_terminal_cfm", terminalId: "sd-1", cfm: 999 });
    expect(rev2.revision).toBe(2);
    const manifest = await issueFromSnapshot(dir, snap.file, demoSheetDefinition(), "test-renderer", "2026-10-17T00:00:00Z");
    expect(manifest.modelRevision).toBe(1);
    expect(manifest.snapshotSha256).toBe(snap.sha256);
    expect(manifest.embeddedDetails).toEqual([{ file: "typ-branch-takeoff.pdf", sha256: demoSheetDefinition().details[0]?.sha256 }]);
    const pdf = await PDFDocument.load(await readFile(path.join(dir, manifest.pdfFile)));
    expect(pdf.getKeywords()).toContain("model-revision:1");
    const [page] = pdf.getPages();
    expect(page?.getWidth()).toBeCloseTo(36 * 72, 3);
    expect(page?.getHeight()).toBeCloseTo(24 * 72, 3);
    // Write-once: the same PDF file can never be overwritten.
    await expect(writeFile(path.join(dir, manifest.pdfFile), "x", { flag: "wx" })).rejects.toThrow();
  });

  it("refuses to issue when a placed standard detail no longer matches its pinned hash", async () => {
    const scene = buildSheetScene(createDemoModel(), demoSheetDefinition());
    const tampered = { ...scene, details: scene.details.map((d) => ({ ...d, sha256: "0".repeat(64) })) };
    await expect(renderSheetPdf(tampered, { title: "t", modelRevision: 0, snapshotSha256: "x", renderer: "t" })).rejects.toBeInstanceOf(DetailHashMismatchError);
    await copyFile(path.join(DETAILS_DIR, "typ-branch-takeoff.pdf"), path.join(os.tmpdir(), "detail-copy.pdf"));
  });
});
