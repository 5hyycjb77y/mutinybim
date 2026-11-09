/**
 * @jest-environment node
 *
 * Round 10 lane V10: the QR encoder printed on issued sheets. Two proofs:
 * (1) module for module equal to a widely used reference encoder (the
 * qrcode-generator port npm itself bundles as `qrcode-terminal`, test-only)
 * for every version a Verify link uses and every mask; (2) a reader written
 * from ISO/IEC 18004 (format bits, unmasking, zig-zag placement, block
 * de-interleaving, byte mode) gets the exact text back out of the matrix.
 * Fails on round 9's code: bim-sheets has no encoder.
 */
import { join } from "node:path";
import { encodeQr, qrRuns, qrVersionFor } from "../src/qr";

interface ReferenceQr {
  addData(text: string): void;
  makeImpl(test: boolean, mask: number): void;
  modules: (boolean | null)[][];
}
type ReferenceQrConstructor = new (version: number, ecl: number) => ReferenceQr;
const LEVEL_M = 0;
// The reference encoder ships in qrcode-terminal: a devDependency in the standalone repo, bundled inside npm in a host that installs npm.
function referenceEncoderPath(): string {
  try {
    return require.resolve("qrcode-terminal/vendor/QRCode/index.js");
  } catch (err) {
    if (!(typeof err === "object" && err !== null && "code" in err && err.code === "MODULE_NOT_FOUND")) throw err;
    return join(__dirname, "..", "..", "..", "node_modules", "npm", "node_modules", "qrcode-terminal", "vendor", "QRCode", "index.js");
  }
}
const Reference = require(referenceEncoderPath()) as ReferenceQrConstructor;

function reference(text: string, version: number, mask: number): boolean[][] {
  const qr = new Reference(version, LEVEL_M);
  qr.addData(text);
  qr.makeImpl(false, mask);
  return qr.modules.map((row) => row.map((v) => v === true));
}

// --- A reader (no error correction: the matrix is clean) -------------------

const BLOCKS_M: readonly (readonly number[])[] = [[1, 26, 16], [1, 44, 28], [1, 70, 44], [2, 50, 32], [2, 67, 43], [4, 43, 27], [4, 49, 31], [2, 60, 38, 2, 61, 39], [3, 58, 36, 2, 59, 37]];
const ALIGN: readonly (readonly number[])[] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];

function maskBit(mask: number, i: number, j: number): boolean {
  switch (mask) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }
}

function reserved(version: number): boolean[][] {
  const n = version * 4 + 17;
  const r = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const mark = (a: number, b: number) => {
    if (a >= 0 && a < n && b >= 0 && b < n) (r[a] as boolean[])[b] = true;
  };
  for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) mark(a, b);
  for (let a = 0; a < 9; a++) for (let b = n - 8; b < n; b++) mark(a, b);
  for (let a = n - 8; a < n; a++) for (let b = 0; b < 9; b++) mark(a, b);
  for (let i = 0; i < n; i++) {
    mark(6, i);
    mark(i, 6);
  }
  const centres = ALIGN[version - 1] ?? [];
  for (const ar of centres) for (const ac of centres) {
    if ((ar < 9 && ac < 9) || (ar < 9 && ac > n - 9) || (ar > n - 9 && ac < 9)) continue;
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) mark(ar + a, ac + b);
  }
  if (version >= 7) for (let i = 0; i < 18; i++) {
    mark(Math.floor(i / 3), (i % 3) + n - 11);
    mark((i % 3) + n - 11, Math.floor(i / 3));
  }
  return r;
}

function readQr(m: readonly (readonly boolean[])[]): string {
  const n = m.length;
  const version = (n - 17) / 4;
  const at = (a: number, b: number) => m[a]?.[b] === true;
  let format = 0;
  for (let i = 0; i < 15; i++) {
    const bit = i < 6 ? at(i, 8) : i < 8 ? at(i + 1, 8) : at(n - 15 + i, 8);
    if (bit) format |= 1 << i;
  }
  const mask = ((format ^ 0b101010000010010) >> 10) & 7;
  const skip = reserved(version);
  const bits: number[] = [];
  let row = n - 1;
  let dir = -1;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (skip[row]?.[col - c]) continue;
        bits.push(at(row, col - c) !== maskBit(mask, row, col - c) ? 1 : 0);
      }
      row += dir;
      if (row < 0 || row >= n) {
        row -= dir;
        dir = -dir;
        break;
      }
    }
  }
  const words: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  const spec = BLOCKS_M[version - 1] ?? [];
  const blocks: { data: number }[] = [];
  for (let i = 0; i < spec.length; i += 3) for (let k = 0; k < (spec[i] ?? 0); k++) blocks.push({ data: spec[i + 2] ?? 0 });
  const data: number[][] = blocks.map(() => []);
  let w = 0;
  const longest = Math.max(...blocks.map((b) => b.data));
  for (let i = 0; i < longest; i++) blocks.forEach((b, k) => {
    if (i < b.data) (data[k] as number[]).push(words[w++] ?? 0);
  });
  const stream = data.flat().flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1));
  const take = (from: number, len: number) => stream.slice(from, from + len).reduce((v, b) => (v << 1) | b, 0);
  if (take(0, 4) !== 0b0100) throw new Error("not byte mode");
  const length = take(4, 8);
  const bytes = Uint8Array.from({ length }, (_, i) => take(12 + i * 8, 8));
  return new TextDecoder().decode(bytes);
}

const VERIFY_LINK = "https://app.example.com/verify/s/Q2hlY2tUaGlzU2hlZXQ0Mg";

describe("v10-qr-roundtrip", () => {
  it("a Verify link fits a small code (version 4) and matches the reference for every mask", () => {
    expect(qrVersionFor(new TextEncoder().encode(VERIFY_LINK).length)).toBe(4);
    for (let mask = 0; mask < 8; mask++) expect(encodeQr(VERIFY_LINK, { version: 4, mask })).toEqual(reference(VERIFY_LINK, 4, mask));
  });

  it.each([
    ["short", "https://x.test/verify/s/abc"],
    ["a Verify link", VERIFY_LINK],
    ["a long origin (4 blocks)", `https://host-preview-branch.example-company.vercel.app/verify/s/${"A".repeat(22)}?from=sheet`],
    ["mixed block sizes", `https://${"v".repeat(120)}.test/verify/s/${"B".repeat(22)}`],
  ])("reads back exactly: %s", (_label, text) => {
    for (let mask = 0; mask < 8; mask++) expect(readQr(encodeQr(text, { mask }))).toBe(text);
    expect(readQr(encodeQr(text))).toBe(text);
  });

  it("dark runs cover exactly the dark modules", () => {
    const m = encodeQr(VERIFY_LINK);
    const painted = m.map((row) => row.map(() => false));
    for (const run of qrRuns(m)) for (let c = run.col; c < run.col + run.length; c++) (painted[run.row] as boolean[])[c] = true;
    expect(painted).toEqual(m);
  });
});
