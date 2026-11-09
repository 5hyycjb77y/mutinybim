/**
 * @jest-environment node
 *
 * Round 10 (coordinator, from V10's open item 5): an issued sheet's Verify
 * code sits in a clear part of the title block (the sheet-number box, right of
 * its label, above the number), inside the border, on both title blocks, and
 * nothing the title block draws crosses it: not the box lines, the label, the
 * sheet number (a long one too), the revision table or the border.
 *
 * Fails on V10's first placement: the code sat 3 pt from the page's
 * bottom-right edge, over the border line and the corner of the title block,
 * in the zone many printers can't print.
 */
import { PAPER_SIZES, TEXT_WIDTH_PER_CHAR, buildSheetSceneFor, type Primitive, type Vec2 } from "@permitzip/bim-kernel";
import { encodeQr, sheetCodeBox } from "@permitzip/bim-sheets";
import { referenceBuilding } from "../../bim-kernel/__tests__/fixtures/electrical-building";

const MM_TO_PT = 72 / 25.4;
const VERIFY_URL = `https://app.example.com/verify/s/${"A".repeat(22)}`;

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The code's square plus its caption, in scene mm (y down). */
function codeBoxMm(paper: Vec2): Box {
  const box = sheetCodeBox(paper.x * MM_TO_PT, paper.y * MM_TO_PT, encodeQr(VERIFY_URL).length);
  const x0 = box.x / MM_TO_PT;
  const x1 = (box.x + box.size) / MM_TO_PT;
  const yTopPdf = box.y + box.size + box.captionHeight;
  return { x0, x1, y0: paper.y - yTopPdf / MM_TO_PT, y1: paper.y - box.y / MM_TO_PT };
}

function segmentHits(a: Vec2, b: Vec2, r: Box): boolean {
  const steps = 200;
  for (let i = 0; i <= steps; i++) {
    const x = a.x + ((b.x - a.x) * i) / steps;
    const y = a.y + ((b.y - a.y) * i) / steps;
    if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1) return true;
  }
  return false;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function hits(p: Primitive, r: Box): boolean {
  if (p.kind === "line") return segmentHits(p.a, p.b, r);
  if (p.kind === "rect") {
    const c = [p.at, { x: p.at.x + p.size.x, y: p.at.y }, { x: p.at.x + p.size.x, y: p.at.y + p.size.y }, { x: p.at.x, y: p.at.y + p.size.y }];
    return c.some((q, i) => segmentHits(q, c[(i + 1) % 4] ?? q, r));
  }
  if (p.kind === "text") {
    const w = p.text.length * p.size * TEXT_WIDTH_PER_CHAR;
    const x0 = p.anchor === "middle" ? p.at.x - w / 2 : p.anchor === "end" ? p.at.x - w : p.at.x;
    return overlaps({ x0, x1: x0 + w, y0: p.at.y - p.size, y1: p.at.y + p.size * 0.25 }, r);
  }
  return false;
}

describe("v10 Verify code in a clear zone of the title block", () => {
  for (const titleBlock of ["arch_d_mutinybim", "ansi_b_mutinybim"] as const) {
    it(`${titleBlock}: inside the border, and nothing on the sheet crosses it`, () => {
      const b = referenceBuilding();
      b.ok({
        type: "create_sheet",
        sheetId: "m-qr",
        number: "M-101.10A",
        name: "Mechanical plan, level one, with a long title",
        titleBlock,
        fields: { client: "A client with a long name", drawn_by: "KE", checked_by: "JR", date: "2026-11-02", status: "Issued for permit" },
        revisions: [
          { number: "1", date: "2026-10-01", description: "Issued for permit" },
          { number: "2", date: "2026-11-02", description: "Revised per comments" },
        ],
      });
      const paper = PAPER_SIZES[titleBlock];
      const code = codeBoxMm(paper);
      // Inside the border (12.7 mm in), with room for the heavy pen.
      expect(code.x0).toBeGreaterThan(12.7);
      expect(code.x1).toBeLessThan(paper.x - 12.7 - 1);
      expect(code.y0).toBeGreaterThan(12.7);
      expect(code.y1).toBeLessThan(paper.y - 12.7 - 1);
      const scene = buildSheetSceneFor(b.head, "m-qr", { projectName: "7303 - Test kitchen", projectNumber: "7303", firmName: "PermitZIP" });
      const crossing = scene.primitives.filter((p) => hits(p, code));
      expect(crossing).toEqual([]);
    });
  }
});
