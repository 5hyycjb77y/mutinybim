/**
 * Round 11 lane X11's workload, shared by x11-preflight-open-issues-fast.test.ts
 * (the work it does) and scripts/perf/mutinybim/x11-preflight-open-issues.ts
 * (what it costs, in the perf gate).
 *
 * An 80-column grid of rooms with 2 typeless heads in every fourth room (an
 * open issue each). 50 rows is about 23k elements and 2,000 open issues; 544
 * rows is about 250k and 21,760. Each sample is one Approve-card preflight
 * (`previewEdit`: the command run on the head through `checkEdit`, then what it
 * re-opens), alternating between the same head and a head committed in between
 * (each preflight then meets a new head, as a busy model's agent does).
 */
import { DEFAULT_SETTINGS, issuesOf, planCommit, previewEdit, requirementsOf, unbindRequirementsSnapshot, type BimElement, type Command, type ModelState } from "../src";
import { bindModelPacks, PackSet } from "../src/packs";
import { spaceIndexStats } from "../src/spaces/space-index";
import { bindStudy, FT, writes, ZT_PACK } from "./g7-fixtures";

const ID = "x11-preflight-open";
const COLS = 80;
const SIZE = 4000;
const NOW = () => "2026-11-02T00:00:00.000Z";
const rect = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const partition = { level: "Level 1", zone: "Z1", discipline: "architecture" as const };

function det(id: string, subject: string, key: string, value: string): BimElement {
  return { id, kind: "determination", version: 1, authoredRev: {}, determination: { subject: { kind: "space", id: subject }, key, value, inputs: [], reasoning: "Synthetic.", decidedBy: "Test", decidedAt: "2026-10-30T15:00:00.000Z", confidence: "high", status: "recorded" } } as unknown as BimElement;
}

function grid(rows: number): ModelState {
  const els: BimElement[] = [{ id: "L1", version: 1, authoredRev: {}, kind: "level", name: "Level 1", elevationMm: 0 } as unknown as BimElement];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < COLS; c++) {
      const id = `R${r}-${c}`;
      const storage = (r * COLS + c) % 4 === 0;
      const x0 = c * SIZE;
      const y0 = r * SIZE;
      els.push({ version: 1, authoredRev: {}, id, kind: "space", name: storage ? "Room" : "Office", number: `${r}${String(c).padStart(2, "0")}`, levelId: "L1", bounds: { kind: "outline", outline: rect(x0, y0, x0 + SIZE, y0 + SIZE) }, origin: { kind: "drawn" }, use: { libraryId: "test", useId: storage ? "storage" : "office" }, occupants: 4 } as unknown as BimElement);
      els.push(det(`DO-${id}`, id, "occupancy", storage ? "S-1" : "B"), det(`DH-${id}`, id, "hazard", storage ? "ordinary_1" : "light"));
      if (c < COLS - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WV-${id}`, kind: "wall", start: { x: x0 + SIZE, y: y0 }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement);
      if (r < rows - 1) els.push({ version: 1, authoredRev: {}, partition, id: `WH-${id}`, kind: "wall", start: { x: x0, y: y0 + SIZE }, end: { x: x0 + SIZE, y: y0 + SIZE }, thickness: 150, height: 3000, wallType: "Partition" } as unknown as BimElement);
      if (storage) {
        els.push({ version: 1, authoredRev: {}, partition, id: `C-${id}`, kind: "ceiling", levelId: "L1", spaceId: id, outline: rect(x0, y0, x0 + SIZE, y0 + SIZE), form: "flat", heightMm: 10 * FT } as unknown as BimElement);
        // A head naming a type the model doesn't have: an open issue (round 8 F's finding).
        for (const k of [1, 3]) els.push({ version: 1, authoredRev: {}, id: `H${k}-${id}`, kind: "part", typeId: "x11-missing-type", levelId: "L1", position: { x: x0 + k * 1000, y: y0 + k * 1000 }, offsetMm: 2700, rotationDeg: 0, mark: `H${k}`, values: {} } as unknown as BimElement);
      }
    }
  }
  return { modelId: ID, revision: 1 as ModelState["revision"], elements: Object.fromEntries(els.map((e) => [e.id, e])), connections: [], settings: DEFAULT_SETTINGS };
}

export interface PreflightRun {
  readonly elementCount: number;
  readonly openIssues: number;
  /** First preflight after load: records the head's ledger. */
  readonly firstMs: number;
  readonly sameHead: readonly number[];
  readonly newHead: readonly number[];
  /** Space index full re-reads during the 18 preflights (0: each stayed on its neighbourhood). */
  readonly previewFullSyncs: number;
}

/** Build the grid, then run the first preflight and 18 more, half after a commit. Throws on any refused check or commit. */
export function runPreflights(rows: number): PreflightRun {
  bindModelPacks(ID, PackSet.create([ZT_PACK]));
  bindStudy(ID);
  try {
    let head = grid(rows);
    const elementCount = Object.keys(head.elements).length;
    const openIssues = issuesOf(head).length;
    requirementsOf(head);
    const edits = (i: number): Command =>
      i % 3 === 0
        ? { type: "move_wall", wallId: `WV-R${(i * 7) % rows}-${(i * 11) % (COLS - 1)}`, delta: { x: 10, y: 0 } }
        : i % 3 === 1
          ? { type: "edit_space", spaceId: `R${(i * 5) % rows}-${(i * 13) % COLS}`, occupants: 10 + i }
          : { type: "move_wall", wallId: `WH-R${(i * 3) % (rows - 1)}-${(i * 17) % COLS}`, delta: { x: 0, y: 10 } };
    const t0 = performance.now();
    const first = writes(() => previewEdit(head, edits(0)));
    const firstMs = performance.now() - t0;
    if (first.status === "refused") throw new Error(`first preflight refused: ${first.message}`);
    let previewFullSyncs = 0;
    const sameHead: number[] = [];
    const newHead: number[] = [];
    for (let i = 1; i <= 18; i++) {
      const command = edits(i);
      const syncs = spaceIndexStats(head.elements).fullSyncs;
      const t = performance.now();
      const answer = writes(() => previewEdit(head, command));
      (i % 2 === 0 ? newHead : sameHead).push(performance.now() - t);
      previewFullSyncs += spaceIndexStats(head.elements).fullSyncs - syncs;
      if (answer.status === "refused") throw new Error(`${command.type} refused: ${answer.message}`);
      if (i % 2 === 0) {
        // Commit it, as an approved card does: the next preflight meets a new head.
        const d = writes(() => planCommit(head, [], { idempotencyKey: `x11-pf-${i}`, baseRevision: head.revision, actor: { id: "agent", name: "Agent", kind: "agent" }, command }, NOW, []));
        if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
        head = d.model;
      }
    }
    return { elementCount, openIssues, firstMs, sameHead, newHead, previewFullSyncs };
  } finally {
    unbindRequirementsSnapshot(ID);
  }
}

export function pct(list: readonly number[], p: number): number {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}
