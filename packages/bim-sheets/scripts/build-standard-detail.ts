/**
 * Builds the firm-standard detail fixture used by the feasibility sheet:
 * "TYPICAL RECTANGULAR BRANCH TAKEOFF" as a deterministic vector PDF.
 * Re-run only when the detail changes, then update STANDARD_DETAIL_SHA256.
 *
 *   npx tsx packages/bim-sheets/scripts/build-standard-detail.ts
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MM = 72 / 25.4;

async function main() {
  const doc = await PDFDocument.create();
  const epoch = new Date("2026-01-01T00:00:00.000Z");
  doc.setTitle("TYPICAL RECTANGULAR BRANCH TAKEOFF");
  doc.setCreator("MutinyBIM standard details");
  doc.setProducer("MutinyBIM standard details");
  doc.setCreationDate(epoch);
  doc.setModificationDate(epoch);
  const w = 180 * MM;
  const h = 120 * MM;
  const page = doc.addPage([w, h]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const k = rgb(0, 0, 0);
  const line = (x1: number, y1: number, x2: number, y2: number, t = 0.35) =>
    page.drawLine({ start: { x: x1 * MM, y: y1 * MM }, end: { x: x2 * MM, y: y2 * MM }, thickness: t * MM, color: k });
  const text = (s: string, x: number, y: number, size = 2.5, b = false) =>
    page.drawText(s, { x: x * MM, y: y * MM, size: (size / 0.718) * MM, font: b ? bold : font, color: k });

  // Main duct (plan), double line.
  line(10, 30, 170, 30, 0.5);
  line(10, 50, 170, 50, 0.5);
  text("MAIN DUCT", 75, 38, 3, true);
  // 45-degree entry takeoff on the top side of the main.
  line(70, 50, 80, 62, 0.5);
  line(100, 50, 90, 62, 0.5);
  line(80, 62, 80, 100, 0.5);
  line(90, 62, 90, 100, 0.5);
  line(80, 100, 90, 100, 0.35);
  // Balancing damper.
  line(78, 80, 92, 84, 0.35);
  page.drawCircle({ x: 85 * MM, y: 82 * MM, size: 1 * MM, borderColor: k, borderWidth: 0.25 * MM });
  // Leaders + notes.
  line(92, 84, 112, 92, 0.18);
  text("MANUAL VOLUME DAMPER", 113, 93);
  text("WITH LOCKING QUADRANT", 113, 88.5);
  line(97, 55, 120, 66, 0.18);
  text("45 DEG ENTRY TAKEOFF,", 121, 67);
  text("SAME SIZE AS BRANCH", 121, 62.5);
  line(80, 105, 60, 108, 0.18);
  text("TO DIFFUSER (SEE PLAN)", 22, 108);
  text("NOTES:", 10, 18, 2.5, true);
  text("1. SEAL ALL JOINTS PER SMACNA SEAL CLASS A.", 10, 13);
  text("2. PROVIDE DAMPER ACCESS AT ALL HARD CEILINGS.", 10, 8.5);

  const bytes = await doc.save({ useObjectStreams: false });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = path.join(here, "../details/typ-branch-takeoff.pdf");
  writeFileSync(out, bytes);
  console.log(out, createHash("sha256").update(bytes).digest("hex"), bytes.length, "bytes");
}

main().catch((err) => {
  console.error("[build-standard-detail] failed", err);
  process.exit(1);
});
