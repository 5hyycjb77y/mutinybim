/**
 * @jest-environment node
 *
 * Black-only printing is the project's choice (Sheets › Black only,
 * `set_print_black_only`), and every print path reads it: Print PDF, Print set
 * and Issue set. In black only, colours print black and halftone and fills stay
 * grey; nothing prints in colour and nothing disappears.
 *
 * Fails on the old code: there was no project choice (the writer's `monochrome`
 * option was never set from the model), so every sheet printed in colour.
 */
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { TAGS_SLOPE_ARROW_FEATURE, DOCUMENTS_PRINT_BLACK_ONLY_FEATURE, DEFAULT_SETTINGS, commandSchema, organizationOf, planCommit, withUpgradePolicy, type ModelState, type Revision, type SheetScene } from "@permitzip/bim-kernel";
import { modelPrintOptions, renderSheetPdfWith } from "../src/pdf-core";

const actor = { id: "avery", name: "Avery", kind: "human" as const };
let seq = 0;

function run(head: ModelState, command: { readonly type: string } & Record<string, unknown>, features: readonly string[] = [DOCUMENTS_PRINT_BLACK_ONLY_FEATURE, TAGS_SLOPE_ARROW_FEATURE]) {
  seq += 1;
  return withUpgradePolicy((f) => features.includes(f), () => planCommit(head, [], { idempotencyKey: `s5b-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, () => "2026-11-07T00:00:00.000Z"));
}

function empty(): ModelState {
  return { modelId: "s5b", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
}

const scene: SheetScene = {
  paper: { x: 841, y: 594 },
  revision: 1,
  primitives: [
    { kind: "line", a: { x: 100, y: 100 }, b: { x: 400, y: 100 }, pen: "medium", color: "#d03030" },
    { kind: "line", a: { x: 100, y: 200 }, b: { x: 400, y: 200 }, pen: "thin", tone: "halftone" },
    { kind: "fill", points: [{ x: 500, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 200 }], grey: 0.6, color: "#2060c0" },
  ],
  tags: [],
  dimensions: [],
  details: [],
  schedule: [],
};

async function colourTriples(bytes: Uint8Array): Promise<number[][]> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const streams: PDFRawStream[] = contents instanceof PDFRawStream ? [contents] : [];
  if (contents instanceof PDFArray) for (const ref of contents.asArray()) { const r = doc.context.lookup(ref); if (r instanceof PDFRawStream) streams.push(r); }
  const text = streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join("\n");
  return [...text.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:rg|RG)\b/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
}

const isGrey = ([r, g, b]: number[]) => Math.abs((r ?? 0) - (g ?? 0)) < 1e-3 && Math.abs((g ?? 0) - (b ?? 0)) < 1e-3;
const meta = { title: "S-1", modelRevision: 1, snapshotSha256: "0".repeat(64), renderer: "test" };

describe("s5b: black-only printing", () => {
  it("the project's choice is stored, kept when other settings change, and cleared back to colour", () => {
    let m = empty();
    expect(organizationOf(m).printBlackOnly).toBe(false);
    const on = run(m, { type: "set_print_black_only", blackOnly: true });
    if (!on.ok) throw new Error(on.error.message);
    m = on.model;
    expect(organizationOf(m).printBlackOnly).toBe(true);
    expect(modelPrintOptions(m)).toEqual({ monochrome: true });
    const cap = run(m, { type: "set_typical_cap", cap: 4 });
    if (!cap.ok) throw new Error(cap.error.message);
    m = cap.model;
    expect(organizationOf(m).printBlackOnly).toBe(true);
    const off = run(m, { type: "set_print_black_only", blackOnly: false });
    if (!off.ok) throw new Error(off.error.message);
    expect(organizationOf(off.model).printBlackOnly).toBe(false);
    expect(modelPrintOptions(off.model)).toEqual({});
  });

  it("an older model server refuses it in words", () => {
    const r = run(empty(), { type: "set_print_black_only", blackOnly: true }, []);
    expect(r.ok ? "stored" : r.error.message).toMatch(/older version/);
  });

  it("in colour the red line prints red; in black only every colour is grey or black and the halftone line is still drawn", async () => {
    const colour = await colourTriples((await renderSheetPdfWith(scene, meta, null, null, null, {})).bytes);
    expect(colour.some((t) => !isGrey(t))).toBe(true);
    const black = await colourTriples((await renderSheetPdfWith(scene, meta, null, null, null, { monochrome: true })).bytes);
    expect(black.length).toBeGreaterThanOrEqual(3);
    expect(black.filter((t) => !isGrey(t))).toEqual([]);
    expect(black.some(([r]) => (r ?? 0) > 0.05 && (r ?? 0) < 0.95)).toBe(true);
  });
});
