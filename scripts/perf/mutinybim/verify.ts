/**
 * Round 10 lane V10: what Verify costs.
 *
 * - sheet.fingerprint.issue: per sheet at issue, draw the Verify code into
 *   the sheet's own PDF and fingerprint it (SHA-256). Measured first.
 * - verify.pdf.fingerprint: SHA-256 of a 50 MB file with WebCrypto, as the
 *   browser does before it sends anything. Budget ≤ 1 s. (Node's WebCrypto;
 *   browsers use the same native digest.)
 * - verify.by_hash is the database lookup (one unique-index match plus the
 *   rate-limit counter). It writes the counter, so it isn't measured here:
 *   Testing measures it through POST /api/verify/hash on the shared stack.
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/verify.ts --samples=21
 *
 * Model size never enters (one sheet's PDF, one file): the same at 250k and 1M.
 * Prints one `@@perf-result` JSON line.
 */
import { createHash, webcrypto } from "node:crypto";
import { stampSheetCode } from "../../../packages/bim-sheets/src/set-pdf";
import { renderDrawingSet, nodeNoteFonts } from "@permitzip/bim-sheets";
import { commandSchema, planCommit } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { emit, gc, memoryMB, type Sample } from "./lib";

const arg = (name: string, fallback: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const samplesPerRun = Number(arg("samples", "21"));
const median = (v: readonly number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;

async function main(): Promise<void> {
  const demo = createDemoModel("perf-verify");
  const d = planCommit(demo, [], { idempotencyKey: "perf-verify-sheet", baseRevision: demo.revision, actor: { id: "perf", name: "Perf", kind: "human" }, command: commandSchema.parse({ type: "create_sheet", sheetId: "e-001", number: "E-001", name: "Legend" }) });
  if (!d.ok) throw new Error(`[perf/verify] create_sheet refused: ${d.error.message}`);
  const set = await renderDrawingSet(d.model, { projectName: "Perf", title: "Perf", renderer: "perf", snapshotSha256: "perf", noteFonts: nodeNoteFonts(), sheets: ["e-001"] });
  const sheet = set.sheetPdfs[0];
  if (!sheet) throw new Error("no sheet rendered");
  const url = "https://verify.example.org/verify/s/Q2hlY2tUaGlzU2hlZXQ0Mg";

  const issue: number[] = [];
  let bytes = 0;
  for (let s = 0; s < samplesPerRun; s++) {
    gc();
    const t0 = performance.now();
    const stamped = await stampSheetCode(sheet.bytes, url);
    createHash("sha256").update(stamped).digest("hex");
    issue.push(performance.now() - t0);
    bytes = stamped.byteLength;
  }

  const file = new Uint8Array(50 * 1024 * 1024);
  for (let i = 0; i < file.length; i += 4096) file[i] = i & 0xff;
  const fingerprint: number[] = [];
  for (let s = 0; s < Math.min(samplesPerRun, 7); s++) {
    gc();
    const t0 = performance.now();
    await webcrypto.subtle.digest("SHA-256", file);
    fingerprint.push(performance.now() - t0);
  }

  const samples: Sample[] = [
    { metric: "sheet.fingerprint.issue", values: issue, counts: { bytes }, note: "one sheet: draw the Verify code (QR) into its PDF, then SHA-256 the result" },
    { metric: "verify.pdf.fingerprint", values: fingerprint, counts: { bytes: file.byteLength }, note: "SHA-256 of a 50 MB file with WebCrypto (what the browser runs before sending only the fingerprint)" },
  ];
  emit({ suite: "sheets", network: "in-process (no network, no Postgres)", participants: 1, workload: { samplesPerRun }, samples, info: { memory: memoryMB(), medians: { issue: median(issue), fingerprint: median(fingerprint) } } });
}

main().catch((err: unknown) => {
  console.error("[perf/verify] failed", err);
  process.exit(1);
});
