/**
 * One run of the sheet workload on a full-BIM tier, in one process: a plan of
 * the author's level cropped to their zone, a section through it and a
 * drawing-only detail, all placed on one sheet with a note, committed through
 * planCommit like any edit. Then, per sample, a duct edit on that zone's trunk
 * is committed and the sheet is regenerated from the new head (sheet.regen),
 * and the sheet is rendered to a vector PDF (pdf.render).
 *
 *   node --expose-gc --import tsx scripts/perf/mutinybim/sheets.ts --tier=1M --samples=21
 *
 * Prints one `@@perf-result` JSON line. Run through run.ts, one tier per process.
 */
import {
  buildSheetSceneFor,
  buildViewScene,
  commandSchema,
  detailSnap,
  documentIndex,
  executeCommand,
  frameForViewport,
  drawDimension,
  layoutSheet,
  modelToPaper,
  modifyCommand,
  rectangleLines,
  planAutoTags,
  planCommit,
  scheduleTable,
  viewWindow,
  windowPaperSize,
  sliceModel,
  warmModel,
  type Command,
  type ModelState,
  type Primitive,
  type ModifyOp,
  type SnapKind,
  type ViewCommand,
} from "@permitzip/bim-kernel";
import { FULL_BIM_TIERS, createFullBimModel } from "@permitzip/bim-first-party/seed";
import { renderSheetPdfWith } from "../../../packages/bim-sheets/src/pdf-core";
import { nodeNoteFonts } from "../../../packages/bim-sheets/src/pdf";
import { renderDrawingSet } from "../../../packages/bim-sheets/src/set-issue";
import { cutIfcPlan } from "../../../packages/bim-sheets/src/ifc-plan";
import { IDENTITY4 } from "../../../packages/bim-sheets/src/plan-geometry";
import { furnitureIfc } from "../../../packages/bim-sheets/__tests__/fixtures/furniture-ifc";
import { FIRST_PARTY_LINKED_DISPLAY } from "../../../packages/bim-sheets/__tests__/fixtures/linked-display";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, emit, memoryMB, round, timeSync, type Counts, type Sample } from "./lib";

interface CutCacheCodec {
  encodeCutEntry(value: unknown): Uint8Array;
  decodeCutEntry(bytes: Uint8Array): unknown;
}

const isCutCacheCodec = (mod: unknown): mod is CutCacheCodec =>
  typeof mod === "object" && mod !== null && "encodeCutEntry" in mod && typeof mod.encodeCutEntry === "function" && "decodeCutEntry" in mod && typeof mod.decodeCutEntry === "function";

/** A host's shared linked-cut cache codec, when this checkout has one; the open-source tree has none, so its row is not run. */
async function hostCutCacheCodec(): Promise<CutCacheCodec | null> {
  const file = path.join(REPO_ROOT, "lib/building-model/cut-cache-key.ts");
  if (!existsSync(file)) return null;
  const mod: unknown = await import(pathToFileURL(file).href);
  if (!isCutCacheCodec(mod)) throw new Error(`[perf] ${file} does not export encodeCutEntry / decodeCutEntry`);
  return mod;
}

const FT = 304.8;
const IN = 25.4;
const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
const tier = arg("tier", "250k");
const samplesPerRun = Number(arg("samples", "21"));
if (!(tier in FULL_BIM_TIERS)) throw new Error(`--tier must be one of ${Object.keys(FULL_BIM_TIERS).join(", ")}`);
const opts = FULL_BIM_TIERS[tier as keyof typeof FULL_BIM_TIERS];
const actor = { id: "perf", name: "Perf", kind: "human" as const };
let seq = 0;

function commit(head: ModelState, command: Command): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `perf-sheets-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) });
  if (!d.ok) throw new Error(`[perf] ${command.type} refused: ${d.error.message}`);
  return d.model;
}

async function main(): Promise<void> {
  const samples: Sample[] = [];
  const add = (metric: string, values: number[], counts?: Counts, note?: string): void => {
    samples.push({ metric, values: values.map((v) => round(v, 3)), ...(counts ? { counts } : {}), ...(note ? { note } : {}) });
  };

  const generated = timeSync(() => createFullBimModel(opts));
  let head: ModelState = generated.value;
  const totalElements = Object.keys(head.elements).length;
  const warm = warmModel(head);

  const level = `L${String(opts.floors).padStart(2, "0")}`;
  const zoneName = `Z${opts.zonesPerFloor}`;
  const p = `${level}-${zoneName}`;
  const trunkId = `${p}-air-t2-s2`;
  const levelElements = Object.keys(sliceModel(head, { areas: [{ level }] }).elements).length;

  // Crop the plan to the author's zone.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of Object.values(sliceModel(head, { areas: [{ level, zone: zoneName }] }).elements)) {
    const pts = "start" in el && "end" in el ? [el.start, el.end] : "position" in el ? [el.position] : []
    for (const q of pts) {
      minX = Math.min(minX, q.x);
      minY = Math.min(minY, q.y);
      maxX = Math.max(maxX, q.x);
      maxY = Math.max(maxY, q.y);
    }
  }
  const crop = { min: { x: minX - 5 * FT, y: minY - 5 * FT }, max: { x: maxX + 5 * FT, y: maxY + 5 * FT } };
  const midY = (minY + maxY) / 2;

  const setup = timeSync(() => {
    head = commit(head, { type: "create_view", viewId: "perf-plan", name: "Perf plan", viewType: "floor_plan", crop, props: { level, scale: 96 } });
    head = commit(head, {
      type: "create_view",
      viewId: "perf-section",
      name: "Perf section",
      viewType: "section",
      props: { level, scale: 96, section: { start: { x: minX, y: midY }, end: { x: maxX, y: midY }, direction: 1, depthMm: 20 * FT } },
    });
    head = commit(head, { type: "create_view", viewId: "perf-detail", name: "Perf detail", viewType: "detail" });
    for (let i = 0; i < 20; i++) head = commit(head, { type: "add_drawing_item", itemId: `perf-d-${i}`, ownerId: "perf-detail", shape: i % 3 === 0 ? "dimension" : "line", points: [{ x: 0, y: i * 100 }, { x: 2000, y: i * 100 }] });
    head = commit(head, { type: "create_sheet", sheetId: "perf-sheet", number: "M-101", name: "Perf sheet", fields: { drawn_by: "PERF" } });
    head = commit(head, { type: "place_viewport", viewportId: "perf-vp-plan", sheetId: "perf-sheet", viewId: "perf-plan", center: { x: 330, y: 230 } });
    head = commit(head, { type: "place_viewport", viewportId: "perf-vp-section", sheetId: "perf-sheet", viewId: "perf-section", center: { x: 330, y: 500 } });
    head = commit(head, { type: "place_viewport", viewportId: "perf-vp-detail", sheetId: "perf-sheet", viewId: "perf-detail", center: { x: 720, y: 480 } });
    head = commit(head, { type: "add_drawing_item", itemId: "perf-note", ownerId: "perf-sheet", shape: "text", points: [{ x: 30, y: 580 }], text: "1. VERIFY ALL DUCT ROUTING IN FIELD." });
  });

  // Each sample: a committed duct edit on the zone's trunk, then the sheet drawn from the new head.
  const regen: number[] = [];
  const section: number[] = [];
  let sectionPrimitives = 0;
  const docCommit: number[] = [];
  let primitives = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    head = commit(head, { type: "resize_run", segmentId: trunkId, profile: { shape: "rect", width: (i % 2 === 0 ? 26 : 24) * IN, height: 12 * IN } });
    const t = timeSync(() => buildSheetSceneFor(head, "perf-sheet", { projectName: "Perf" }));
    regen.push(t.ms);
    primitives = t.value.primitives.length;
    const sec = timeSync(() => buildViewScene(head, "perf-section"));
    section.push(sec.ms);
    sectionPrimitives = sec.value.scene.primitives.length;
    const moved = timeSync(() => commit(head, { type: "move_viewport", viewportId: "perf-vp-detail", center: { x: 720 + (i % 2), y: 480 } }));
    head = moved.value;
    docCommit.push(moved.ms);
  }
  // What a plan shows: the pilot plan with a top, a bottom and a depth set, regenerated after the same duct edit.
  head = commit(head, { type: "set_view_properties", viewId: "perf-plan", props: { viewBottomMm: 0, viewDepthMm: 2 * FT, viewTopMm: 12 * FT } });
  const rangeRegen: number[] = [];
  let rangePrimitives = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    head = commit(head, { type: "resize_run", segmentId: trunkId, profile: { shape: "rect", width: (i % 2 === 0 ? 26 : 24) * IN, height: 12 * IN } });
    const t = timeSync(() => buildViewScene(head, "perf-plan"));
    rangeRegen.push(t.ms);
    rangePrimitives = t.value.scene.primitives.length;
  }
  head = commit(head, { type: "set_view_properties", viewId: "perf-plan", props: { viewBottomMm: null, viewTopMm: null } });

  // Crop drag on the 1M head. Per pointer move the editor only moves a grip on the frame it already has
  // (crop.drag.preview); release predicts set_view_crop locally (edit.preview.set_view_crop), then the sheet redraws.
  const dragPreview: number[] = [];
  const cropPredict: number[] = [];
  const cropRegen: number[] = [];
  const planView = head.elements["perf-plan"];
  const planVp = head.elements["perf-vp-plan"];
  if (planView?.kind !== "view" || planVp?.kind !== "viewport") throw new Error("[perf] plan view or viewport missing");
  for (let i = 0; i < samplesPerRun; i++) {
    const grow = (i + 1) * 2 * FT;
    const t = timeSync(() => {
      const f = frameForViewport(head, planVp, planView);
      let last = f.size;
      for (let k = 0; k < 60; k++) {
        const next = { min: crop.min, max: { x: crop.max.x + (grow * k) / 60, y: crop.max.y } };
        last = windowPaperSize(viewWindow(planView, next), planVp.scale);
      }
      return last;
    });
    dragPreview.push(t.ms / 60);
    const command = commandSchema.parse({ type: "set_view_crop", viewId: "perf-plan", crop: { min: crop.min, max: { x: crop.max.x + grow, y: crop.max.y } } });
    const predicted = timeSync(() => executeCommand(head, command));
    if (!predicted.value.ok) throw new Error(`[perf] set_view_crop refused: ${predicted.value.error.message}`);
    cropPredict.push(predicted.ms);
    const next = predicted.value.model;
    cropRegen.push(timeSync(() => buildSheetSceneFor(next, "perf-sheet", { projectName: "Perf" })).ms);
  }

  const scene = buildSheetSceneFor(head, "perf-sheet", { projectName: "Perf" });
  const pdf: number[] = [];
  let pdfBytes = 0;
  for (let i = 0; i < Math.min(samplesPerRun, 11); i++) {
    const t0 = performance.now();
    const out = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: head.revision, snapshotSha256: "perf", renderer: "perf" }, null, nodeNoteFonts());
    pdf.push(performance.now() - t0);
    pdfBytes = out.bytes.byteLength;
  }

  // Drawing-set work an agent does: a 500-step batch, a schedule over the whole model, layout, and the set PDF.
  // Each sample commits a new 500-step batch on the latest head, as successive approvals do. (Re-running one
  // batch on the same head would time the element store's rebuild after a sibling revision appended, not the batch.)
  const batch: number[] = [];
  // A detail view that isn't placed, so the batches don't change what the set prints.
  head = commit(head, { type: "create_view", viewId: "perf-batch", name: "Perf batch", viewType: "detail" });
  for (let i = 0; i < Math.min(samplesPerRun, 7); i++) {
    const batchCommand = commandSchema.parse({
      type: "batch_documents",
      label: "perf",
      commands: Array.from({ length: 500 }, (_, k) => ({ type: "add_drawing_item", itemId: `perf-b-${i}-${k}`, ownerId: "perf-batch", shape: "line", points: [{ x: 0, y: k * 10 }, { x: 1000, y: k * 10 }] })),
    });
    const t = timeSync(() => commit(head, batchCommand));
    head = t.value;
    batch.push(t.ms);
  }
  const scheduleDef = { category: "air_terminal" as const, columns: [{ field: "mark" }, { field: "type" }, { field: "level" }, { field: "cfm" }] };
  const scheduleMs: number[] = [];
  let scheduleRows = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(() => scheduleTable(head, scheduleDef));
    scheduleMs.push(t.ms);
    scheduleRows = t.value.evaluated.rows.length;
  }
  const layoutMs: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) layoutMs.push(timeSync(() => layoutSheet(head, "perf-sheet", { mode: "pack", fitScales: true })).ms);
  head = commit(head, { type: "create_sheet", sheetId: "perf-601", number: "M-601", name: "Schedules" });
  head = commit(head, { type: "create_view", viewId: "perf-schedule", name: "Air device schedule", viewType: "schedule", props: { schedule: { ...scheduleDef, filters: [{ field: "level", op: "equals", value: level }] } } });
  head = commit(head, { type: "place_viewport", viewportId: "perf-vp-schedule", sheetId: "perf-601", viewId: "perf-schedule", center: { x: 200, y: 200 } });
  head = commit(head, { type: "create_sheet", sheetId: "perf-001", number: "M-001", name: "Notes and index" });
  head = commit(head, { type: "create_view", viewId: "perf-index", name: "Sheet index", viewType: "schedule", props: { schedule: { category: "sheet_list", columns: [{ field: "number" }, { field: "name" }] } } });
  head = commit(head, { type: "place_viewport", viewportId: "perf-vp-index", sheetId: "perf-001", viewId: "perf-index", center: { x: 600, y: 100 } });
  head = commit(head, { type: "add_drawing_item", itemId: "perf-notes", ownerId: "perf-001", shape: "text", points: [{ x: 30, y: 40 }], text: "1. GENERAL NOTES APPLY TO ALL SHEETS." });
  const setMs: number[] = [];
  let setBytes = 0;
  for (let i = 0; i < Math.min(samplesPerRun, 5); i++) {
    const t0 = performance.now();
    const set = await renderDrawingSet(head, { projectName: "Perf", title: "Perf set", renderer: "perf", snapshotSha256: "perf", noteFonts: nodeNoteFonts() });
    setMs.push(performance.now() - t0);
    setBytes = set.pdf.bytes.byteLength;
  }

  // After the set is printed, so set.pdf.render's workload is unchanged.
  // A saved 3D view of the author's zone (pre-cropped to its storey and bay) on its own sheet: drawn
  // from its camera, clipped to its 3D box, hidden lines removed; regenerated after each duct edit.
  const zoneIds = Object.values(sliceModel(head, { areas: [{ level, zone: zoneName }] }).elements)
    .filter((el) => el.kind !== "view" && el.kind !== "sheet" && el.kind !== "viewport" && el.kind !== "drawing_item" && el.kind !== "level")
    .map((el) => el.id)
    .slice(0, 5000);
  head = commit(head, { type: "create_3d_view", viewId: "perf-3d", name: "Perf zone 3D", fit: { elementIds: zoneIds } });
  // One storey's isometric (the synthetic building has no level elements, so every floor would otherwise stand at the same height).
  head = commit(head, { type: "set_view_properties", viewId: "perf-3d", props: { level } });
  head = commit(head, { type: "create_sheet", sheetId: "perf-501", number: "M-501", name: "Perf isometric" });
  head = commit(head, { type: "place_viewport", viewportId: "perf-vp-3d", sheetId: "perf-501", viewId: "perf-3d", center: { x: 400, y: 300 } });
  const regen3d: number[] = [];
  const camera3d: number[] = [];
  let prims3d = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    head = commit(head, { type: "resize_run", segmentId: trunkId, profile: { shape: "rect", width: (i % 2 === 0 ? 26 : 24) * IN, height: 12 * IN } });
    const t = timeSync(() => buildSheetSceneFor(head, "perf-501", { projectName: "Perf" }));
    regen3d.push(t.ms);
    prims3d = t.value.primitives.length;
    const view3d = head.elements["perf-3d"];
    const cam = view3d?.kind === "view" ? view3d.props?.camera3d : undefined;
    if (!cam) throw new Error("[perf] 3D view has no camera");
    const turned = commandSchema.parse({ type: "set_3d_view_camera", viewId: "perf-3d", camera: { ...cam, eye: { ...cam.eye, x: cam.eye.x + (i % 2 === 0 ? 1000 : -1000) } } });
    camera3d.push(timeSync(() => executeCommand(head, turned)).ms);
  }

  // Drafting annotation on the full model: auto-tag the pilot plan, regenerate dimensions after an edit, redraw a busy detail.
  const autotag: number[] = [];
  let tagCount = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(() => planAutoTags(head, "perf-plan", { categories: ["duct", "air_terminal"], idPrefix: `perf-tag-${i}`, limit: 500 }));
    autotag.push(t.ms);
    tagCount = t.value.items.length;
  }
  const zoneRuns = Object.values(sliceModel(head, { areas: [{ level, zone: zoneName }] }).elements).filter((e) => e.kind === "duct_segment" || e.kind === "run_segment").slice(0, 200);
  for (let start = 0; start < zoneRuns.length; start += 100) {
    head = commit(head, {
      type: "batch_documents",
      commands: zoneRuns.slice(start, start + 100).flatMap((el) => {
        if (el.kind !== "duct_segment" && el.kind !== "run_segment") return [];
        return [{ type: "add_drawing_item", itemId: `perf-dim-${el.id}`, ownerId: "perf-plan", shape: "dimension", points: [{ x: el.start.x, y: el.start.y }, { x: el.end.x, y: el.end.y }], dim: { kind: "aligned", refs: [{ elementId: el.id, anchor: "start" }, { elementId: el.id, anchor: "end" }], offsetMm: 6 } }];
      }),
    });
  }
  const dimRegen: number[] = [];
  let dimsDrawn = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    head = commit(head, { type: "resize_run", segmentId: trunkId, profile: { shape: "rect", width: (i % 2 === 0 ? 28 : 24) * IN, height: 12 * IN } });
    const view = head.elements["perf-plan"];
    if (view?.kind !== "view") throw new Error("[perf] plan view missing");
    const dims = (documentIndex(head).itemsByOwner.get("perf-plan") ?? []).filter((it) => it.dim);
    const t = timeSync(() => {
      const prims: Primitive[] = [];
      for (const item of dims) drawDimension({ model: head, view, toPaper: (q) => ({ x: q.x / 96, y: -q.y / 96 }), scale: 96, prims }, item);
      return prims.length;
    });
    dimRegen.push(t.ms);
    dimsDrawn = dims.length;
  }
  head = commit(head, { type: "create_view", viewId: "perf-det2k", name: "Perf busy detail", viewType: "detail" });
  for (let b = 0; b < 4; b++) {
    head = commit(head, { type: "batch_documents", commands: Array.from({ length: 400 }, (_, k) => ({ type: "add_drawing_item", itemId: `perf-dl-${b}-${k}`, ownerId: "perf-det2k", shape: "line", points: [{ x: k * 10, y: b * 1000 }, { x: k * 10 + 300, y: b * 1000 + 600 }] })) });
  }
  head = commit(head, { type: "batch_documents", commands: Array.from({ length: 300 }, (_, k) => ({ type: "add_drawing_item", itemId: `perf-dd-${k}`, ownerId: "perf-det2k", shape: "dimension", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], dim: { kind: "linear", direction: "horizontal", refs: [{ elementId: `perf-dl-0-${k}`, anchor: "start" }, { elementId: `perf-dl-0-${k}`, anchor: "end" }], offsetMm: 5 } })) });
  head = commit(head, { type: "batch_documents", commands: Array.from({ length: 100 }, (_, k) => ({ type: "create_text_note", itemId: `perf-dn-${k}`, ownerId: "perf-det2k", at: { x: k * 40, y: 5000 }, width: 40, paragraphs: [{ runs: [{ text: `NOTE ${k}: SEAL ALL JOINTS AND SEAMS` }] }] })) });
  // Everything drawn is inside the crop (it was set while the view was empty).
  head = commit(head, { type: "set_view_crop", viewId: "perf-det2k", fit: true });
  const detailRedraw: number[] = [];
  let detailPrims = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(() => buildViewScene(head, "perf-det2k"));
    detailRedraw.push(t.ms);
    detailPrims = t.value.scene.primitives.length;
  }

  // Detailing (slice 2b): a 1,000-item detail of hatches, components, insulation and curves; a hatch-heavy detail; modify and snap on it.
  head = commit(head, { type: "create_view", viewId: "perf-det-d", name: "Perf detailing", viewType: "detail" });
  const dItems: ViewCommand[] = [];
  const symbols = ["trapeze_hanger", "gate_valve", "duct_rect_section", "pipe_section_insulated", "concrete_anchor", "strut_channel"];
  for (let k = 0; k < 200; k++) {
    const x = (k % 20) * 900;
    const y = Math.floor(k / 20) * 900;
    dItems.push({ type: "add_drawing_item", itemId: `perf-dr-${k}`, ownerId: "perf-det-d", shape: "region", points: [{ x, y }, { x: x + 600, y }, { x: x + 600, y: y + 300 }, { x, y: y + 300 }], fill: { pattern: k % 2 === 0 ? "concrete" : "crosshatch" }, detailGroup: `g${k % 50}` });
  }
  for (let k = 0; k < 300; k++) dItems.push({ type: "add_drawing_item", itemId: `perf-dc-${k}`, ownerId: "perf-det-d", shape: "component", points: [{ x: (k % 30) * 600, y: 10_000 + Math.floor(k / 30) * 600 }], component: { symbolId: symbols[k % symbols.length] ?? "gate_valve" }, detailGroup: `g${k % 50}` });
  for (let k = 0; k < 100; k++) dItems.push({ type: "add_drawing_item", itemId: `perf-db-${k}`, ownerId: "perf-det-d", shape: "batt", points: [{ x: 0, y: 17_000 + k * 120 }, { x: 3000, y: 17_000 + k * 120 }], batt: { thicknessMm: 50.8 } });
  for (let k = 0; k < 100; k++) dItems.push({ type: "add_drawing_item", itemId: `perf-dp-${k}`, ownerId: "perf-det-d", shape: "repeat", points: [{ x: 4000, y: 17_000 + k * 120 }, { x: 7000, y: 17_000 + k * 120 }], component: { symbolId: "threaded_rod" } });
  for (let k = 0; k < 200; k++) {
    const x = 8000 + (k % 20) * 500;
    const y = 17_000 + Math.floor(k / 20) * 500;
    dItems.push(k % 2 === 0 ? { type: "add_drawing_item", itemId: `perf-da-${k}`, ownerId: "perf-det-d", shape: "arc", points: [{ x, y }, { x: x + 200, y }, { x, y: y + 200 }], ccw: true } : { type: "add_drawing_item", itemId: `perf-ds-${k}`, ownerId: "perf-det-d", shape: "spline", points: [{ x, y }, { x: x + 100, y: y + 150 }, { x: x + 200, y }, { x: x + 300, y: y + 150 }] });
  }
  for (let k = 0; k < 100; k++) dItems.push({ type: "add_drawing_item", itemId: `perf-dq-${k}`, ownerId: "perf-det-d", shape: "polyline", points: Array.from({ length: 6 }, (_, j) => ({ x: 20_000 + j * 200, y: k * 150 + (j % 2) * 80 })) });
  for (let start = 0; start < dItems.length; start += 500) head = commit(head, { type: "batch_documents", commands: dItems.slice(start, start + 500) });
  head = commit(head, { type: "set_view_crop", viewId: "perf-det-d", fit: true });
  const detailingRedraw: number[] = [];
  let detailingPrims = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(() => buildViewScene(head, "perf-det-d"));
    detailingRedraw.push(t.ms);
    detailingPrims = t.value.scene.primitives.length;
  }
  head = commit(head, { type: "create_view", viewId: "perf-det-h", name: "Perf hatch", viewType: "detail", props: { scale: 1 } });
  head = commit(head, {
    type: "batch_documents",
    commands: Array.from({ length: 50 }, (_, k) => {
      const x = (k % 5) * 260;
      const y = Math.floor(k / 5) * 160;
      return { type: "add_drawing_item" as const, itemId: `perf-dh-${k}`, ownerId: "perf-det-h", shape: "region" as const, points: [{ x, y }, { x: x + 254, y }, { x: x + 254, y: y + 152 }, { x, y: y + 152 }], fill: k % 2 === 0 ? { pattern: "crosshatch" as const, spacingMm: 1.5 } : { pattern: "concrete" as const } };
    }),
  });
  head = commit(head, { type: "set_view_crop", viewId: "perf-det-h", fit: true });
  const hatchRedraw: number[] = [];
  let hatchPrims = 0;
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(() => buildViewScene(head, "perf-det-h"));
    hatchRedraw.push(t.ms);
    hatchPrims = t.value.scene.primitives.length;
  }
  const detailingItems = documentIndex(head).itemsByOwner.get("perf-det-d") ?? [];
  const picked = detailingItems.slice(0, 500).map((it) => it.id as string);
  const modifyMs: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const t = timeSync(() => modifyCommand(detailingItems, picked, { op: "rotate", center: { x: 0, y: 0 }, angleDeg: 15 + i }, "perf-det-d", `perf-mod-${i}`));
    if (!t.value.ok) throw new Error(`[perf] modify refused: ${t.value.reason}`);
    modifyMs.push(t.ms);
  }
  // Joined detail lines: 500 rectangles (2,000 lines, each joined at its corners) in one detail.
  head = commit(head, { type: "create_view", viewId: "perf-det-j", name: "Perf joined lines", viewType: "detail" });
  const jCommands: ViewCommand[] = [];
  for (let k = 0; k < 500; k++) {
    const x = (k % 25) * 1000;
    const y = Math.floor(k / 25) * 700;
    rectangleLines({ x, y }, { x: x + 800, y: y + 500 }).forEach(([p, q], s) => jCommands.push({ type: "add_drawing_item", itemId: `perf-dj-${k}-${s}`, ownerId: "perf-det-j", shape: "line", points: [p, q] }));
  }
  for (let start = 0; start < jCommands.length; start += 500) head = commit(head, { type: "batch_documents", commands: jCommands.slice(start, start + 500) });
  const joinedItems = documentIndex(head).itemsByOwner.get("perf-det-j") ?? [];
  const sideOf = (k: number, s: number) => `perf-dj-${k}-${s}`;
  const plan = (ids: string[], op: ModifyOp, prefix: string) => {
    const made = modifyCommand(joinedItems, ids, op, "perf-det-j", prefix);
    if (!made.ok) throw new Error(`[perf] joined-line modify refused: ${made.reason}`);
    return made;
  };
  const joinedMove: number[] = [];
  const joinedOffset: number[] = [];
  const joinedFillet: number[] = [];
  const joinedTrim: number[] = [];
  const allSides = Array.from({ length: 500 }, (_, k) => [0, 1, 2, 3].map((s) => sideOf(k, s))).flat();
  for (let i = 0; i < samplesPerRun; i++) {
    // Move one side of every rectangle: 500 picked, 1,000 joined sides stretch to follow.
    joinedMove.push(timeSync(() => plan(Array.from({ length: 500 }, (_, k) => sideOf(k, 1)), { op: "move", delta: { x: 50 + i, y: 0 } }, `perf-jm-${i}`)).ms);
    // Offset every closed chain at once (2,000 lines in, 2,000 out, corners re-met).
    joinedOffset.push(timeSync(() => plan(allSides, { op: "offset", distance: 50, side: { x: 400, y: 250 } }, `perf-jo-${i}`)).ms);
    joinedFillet.push(timeSync(() => plan([sideOf(i % 500, 0), sideOf(i % 500, 1)], { op: "fillet_arc", radius: 100 }, `perf-jf-${i}`)).ms);
    joinedTrim.push(timeSync(() => plan([sideOf(i % 500, 0)], { op: "split", at: { x: (i % 25) * 1000 + 400, y: Math.floor((i % 500) / 25) * 700 } }, `perf-jt-${i}`)).ms);
  }
  const detFrame = buildViewScene(head, "perf-det-d").frame;
  const toPaperD = (q: { x: number; y: number }) => (detFrame ? modelToPaper(detFrame, q) : q);
  const snapKinds = new Set<SnapKind>(["endpoint", "midpoint", "center", "intersection", "perpendicular"]);
  const snapMs: number[] = [];
  for (let i = 0; i < samplesPerRun; i++) {
    const t0 = performance.now();
    for (let j = 0; j < 60; j++) detailSnap(detailingItems, toPaperD, { x: 100 + ((i * 60 + j) % 400), y: 100 + ((i * 7 + j) % 300) }, { kinds: snapKinds, reachMm: 3, from: { x: 50, y: 50 } });
    snapMs.push((performance.now() - t0) / 60);
  }

  const counts: Counts = { totalElements, subscribedElements: levelElements, visibleSolids: primitives };
  add("batch.documents.500", batch, { totalElements }, "planCommit of a 500-step batch_documents (add_drawing_item) on the latest full-model head, one new batch per sample.");
  add("schedule.evaluate", scheduleMs, { totalElements, visibleSolids: scheduleRows }, "scheduleTable for an air terminal schedule over the whole model (rows, sort, column widths). visibleSolids = rows.");
  add("layout.sheet", layoutMs, { totalElements }, "layoutSheet(pack, fitScales) on the pilot sheet's three viewports.");
  add("autotag.500", autotag, { totalElements, visibleSolids: tagCount }, "planAutoTags on the pilot plan for ducts and air terminals (limit 500). visibleSolids = tags placed.");
  add("dimension.regen", dimRegen, { totalElements, visibleSolids: dimsDrawn }, "After a committed resize_run on the trunk, resolve and draw every associative dimension in the pilot plan. visibleSolids = dimensions.");
  add("detail.redraw.2000", detailRedraw, { totalElements, visibleSolids: detailPrims }, "buildViewScene on a detail view with 1,600 lines, 300 dimensions that follow them and 100 notes. visibleSolids = primitives.");
  add("detail.redraw.detailing", detailingRedraw, { totalElements, visibleSolids: detailingPrims }, "buildViewScene on a detail view with 200 hatched regions, 300 components, 100 batts, 100 repeating details, 200 arcs and splines, 100 polylines. visibleSolids = primitives.");
  add("detail.hatch.heavy", hatchRedraw, { totalElements, visibleSolids: hatchPrims }, "buildViewScene on a detail view with 50 regions of about 10 x 6 inches on paper, crosshatch at 1.5 mm and concrete. visibleSolids = primitives.");
  add("detail.modify.500", modifyMs, { totalElements }, "modifyCommand rotating 500 picked items (with their detail groups) in the 1,000-item detailing view.");
  add("detail.lines.move_joined", joinedMove, { totalElements }, "modifyCommand moving one side of each of 500 rectangles (2,000 joined lines); the 1,000 sides joined to them stretch to follow.");
  add("detail.lines.offset_chains", joinedOffset, { totalElements }, "modifyCommand offsetting all 2,000 joined lines (500 closed rectangles) inward at once, corners re-met.");
  add("detail.lines.fillet_arc", joinedFillet, { totalElements }, "modifyCommand Fillet Arc on one corner in the 2,000-line detail (plan, joined-end lookup, one batch).");
  add("detail.lines.split", joinedTrim, { totalElements }, "modifyCommand Split on one line in the 2,000-line detail.");
  add("detail.snap.move", snapMs, { totalElements }, "detailSnap per pointer move over the 1,000-item detailing view (mean of 60 moves per sample).");
  add("set.pdf.render", setMs, { totalElements, bytes: setBytes }, "renderDrawingSet: M-001 (notes + sheet index), M-101 (the pilot sheet), M-601 (an air terminal schedule of the author's level), merged into one PDF.");
  add("plan.regen.range", rangeRegen, { totalElements, subscribedElements: levelElements, visibleSolids: rangePrimitives }, "buildViewScene on the pilot plan with a top (12 ft), a bottom (the level) and a depth (2 ft) set, after a committed resize_run on the zone trunk: every element's height checked against the range. visibleSolids = plan primitives.");
  const linked = await linkedPlanCut(Math.min(samplesPerRun, 5));
  add("linked.plan.cut.large", linked.total, { totalElements: linked.elements, visibleSolids: linked.occluders, bytes: linked.bytes }, "cutIfcPlan with hidden lines removed on a synthetic architect's floor of 1,600 rooms (6,400 furniture elements: tables, chairs tucked under them, chairs in the open, cups), cut at 4 ft. What the printed drawing's background costs the server whenever a plan's settings change. visibleSolids = occluding faces.");
  add("linked.plan.hidden", linked.hidden, { totalElements: linked.elements, visibleSolids: linked.occluders }, "The hidden-line step alone of that cut: every projection and plan-symbol edge split against the faces above it (kernel FaceIndex + splitHidden).");
  // Four times the floor (25,600 furniture elements, about twice a real four-storey linked architect model): the cut must grow with the floor, not faster.
  const linkedXl = await linkedPlanCut(Math.min(samplesPerRun, 3), 80);
  add("linked.plan.cut.xl", linkedXl.total, { totalElements: linkedXl.elements, visibleSolids: linkedXl.occluders, bytes: linkedXl.bytes }, "cutIfcPlan with hidden lines removed on a 6,400-room synthetic floor (25,600 furniture elements), cut at 4 ft. Same work as linked.plan.cut.large at four times the size.");
  add("linked.plan.hidden.xl", linkedXl.hidden, { totalElements: linkedXl.elements, visibleSolids: linkedXl.occluders }, "The hidden-line step alone of the 25,600-element cut.");
  if (linkedXl.cacheDecode.length > 0) add("linked.plan.cut.cache.decode", linkedXl.cacheDecode, { totalElements: linkedXl.elements, bytes: linkedXl.cacheBytes }, "A warm hit on the host's shared linked-cut cache for the 25,600-element cut, server side: gunzip and parse the stored entry. bytes = the stored gzip entry. The storage round trip is on top (same region, tens of ms).");

  // Tag styles (after everything above, so their workloads are unchanged): 10,000 tags on a plan of the whole top
  // level name one style; editing the style changes every one of them (one model edit), then the plan redraws.
  const tagTargets = Object.values(sliceModel(head, { areas: [{ level }] }).elements)
    .filter((el) => el.kind === "duct_segment" || el.kind === "terminal")
    .slice(0, 10_000);
  head = commit(head, { type: "create_view", viewId: "perf-tags", name: "Perf tags", viewType: "floor_plan", props: { level, scale: 96 } });
  head = commit(head, { type: "create_tag_style", styleId: "perf-tag-style", name: "Perf tag style", lines: ["{mark}"], box: "box" });
  for (let start = 0; start < tagTargets.length; start += 500) {
    head = commit(head, {
      type: "batch_documents",
      commands: tagTargets.slice(start, start + 500).map((el) => {
        const at = "start" in el && "end" in el ? { x: (el.start.x + el.end.x) / 2, y: (el.start.y + el.end.y) / 2 + 600 } : "position" in el ? { x: el.position.x + 600, y: el.position.y } : { x: 0, y: 0 };
        return { type: "add_drawing_item" as const, itemId: `perf-st-${el.id}`, ownerId: "perf-tags", shape: "tag" as const, points: [at], tag: { elementId: el.id, template: "auto" as const, leader: false, styleId: "perf-tag-style" } };
      }),
    });
  }
  const styleEdit: number[] = [];
  const styleRedraw: number[] = [];
  let styledTags = 0;
  for (let i = 0; i < Math.min(samplesPerRun, 11); i++) {
    const edited = timeSync(() => commit(head, { type: "update_tag_style", styleId: "perf-tag-style", lines: i % 2 === 0 ? ["{mark}", "PERF"] : ["{mark}"], textSizeMm: i % 2 === 0 ? 2.4 : 2.0 }));
    head = edited.value;
    styleEdit.push(edited.ms);
    const after = head;
    const t = timeSync(() => buildViewScene(after, "perf-tags"));
    styleRedraw.push(t.ms);
    styledTags = t.value.scene.primitives.filter((q) => q.kind === "text").length;
  }
  add("tag.style.edit.10k", styleEdit, { totalElements, visibleSolids: tagTargets.length }, "planCommit of update_tag_style (lines and text size) on a model where 10,000 tags in one plan name that style. One edit, whatever the tag count. visibleSolids = tags naming the style.");
  add("tag.style.redraw.10k", styleRedraw, { totalElements, visibleSolids: styledTags }, "buildViewScene on the plan of the whole top level holding those 10,000 styled tags, right after the style edit. visibleSolids = text primitives drawn.");
  add("sheet.regen", regen, counts, "Committed resize_run on the zone trunk, then buildSheetSceneFor on the new head: plan of the whole level cropped to one zone, a section, a 20-item detail, a note and the title block. visibleSolids = scene primitives.");
  add("section.generate", section, { totalElements, subscribedElements: levelElements, visibleSolids: sectionPrimitives }, "buildViewScene on the section through the zone right after the duct edit: cut shapes, beyond edges with hidden-line removal, level lines. visibleSolids = section primitives.");
  add("pdf.render", pdf, { ...counts, bytes: pdfBytes }, "renderSheetPdfWith on the same scene (vector, true size, ARCH D).");
  add("commit.document.move_viewport", docCommit, { totalElements }, "planCommit of a move_viewport on the full model, informational.");
  add("crop.drag.preview", dragPreview, { totalElements }, "Per pointer move while dragging a crop grip: the new window and frame size on the full-model head (mean of 60 moves per sample). The model is not touched until release.");
  add("edit.preview.set_view_crop", cropPredict, { totalElements }, "executeCommand(set_view_crop) on the full-model head: the local prediction on release, with the placed viewport following the crop.");
  add("sheet.regen.crop", cropRegen, counts, "buildSheetSceneFor right after that crop change: the viewport redrawn at its new size.");
  add("sheet.regen.3d", regen3d, { totalElements, visibleSolids: prims3d }, "Committed resize_run on the zone trunk, then buildSheetSceneFor on M-501: one saved 3D view of the author's zone cropped to its storey and bay, drawn from its camera with hidden lines removed. visibleSolids = scene primitives.");
  add("edit.preview.set_3d_view_camera", camera3d, { totalElements }, "executeCommand(set_3d_view_camera) on the full-model head: the local prediction, with the placed viewport's frame following the box seen from the new camera.");

  emit({
    suite: "sheets",
    network: "in-process (no network, no Postgres)",
    participants: 1,
    workload: { tier, totalElements, level, zone: zoneName, levelElements, samplesPerRun, setupCommits: 29 + 1, sheet: "M-101 (plan + section + detail + note)" },
    samples,
    info: {
      generateMs: round(generated.ms, 1),
      setupMs: round(setup.ms, 1),
      warmModel: { indexMs: round(warm.indexMs, 1), validateMs: round(warm.validateMs, 1) },
      documents: { views: documentIndex(head).views.length, sheets: documentIndex(head).sheets.length },
      memory: memoryMB(),
    },
  });
  process.exit(0);
}

/** The large linked-model plan cut, per sample: whole cut and its hidden-line step (ms). */
async function linkedPlanCut(samples: number, grid = 40): Promise<{ total: number[]; hidden: number[]; elements: number; occluders: number; bytes: number; cacheDecode: number[]; cacheBytes: number }> {
  const WebIFC = await import("web-ifc");
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const bytes = new TextEncoder().encode(furnitureIfc({ grid }));
  const modelId = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  const total: number[] = [];
  const hidden: number[] = [];
  let elements = 0;
  let occluders = 0;
  let last: unknown = null;
  try {
    for (let i = 0; i < samples; i++) {
      const { plan, stats } = cutIfcPlan(api, modelId, { id: "perf-arch", file: "perf-furniture.ifc", bytes, discipline: "architecture", ifcToHostMetres: IDENTITY4, storeyName: "Level 1", cutAboveLevelMm: 4 * FT, display: FIRST_PARTY_LINKED_DISPLAY });
      total.push(stats.ms.total);
      hidden.push(stats.ms.hidden);
      elements = stats.elementsWithGeometry;
      occluders = stats.occluders;
      last = { referenceId: "perf-arch", label: "Perf", discipline: "architecture", plan, storey: "Level 1" };
    }
  } finally {
    api.CloseModel(modelId);
  }
  const codec = await hostCutCacheCodec();
  const cacheDecode: number[] = [];
  let cacheBytes = 0;
  if (codec) {
    const entry = codec.encodeCutEntry(last);
    cacheBytes = entry.length;
    for (let i = 0; i < Math.max(5, samples); i++) {
      const t0 = performance.now();
      codec.decodeCutEntry(entry);
      cacheDecode.push(performance.now() - t0);
    }
  }
  return { total, hidden, elements, occluders, bytes: bytes.length, cacheDecode, cacheBytes };
}

main().catch((err) => {
  console.error("[perf] sheets run failed", err);
  process.exit(1);
});
