/**
 * @jest-environment node
 *
 * #20: a part drafted from a cut sheet (a modeled body, `geometry: []`) prints
 * on sheets: plan, 3D view, PDF. The fixture is shaped like the saved part
 * from the 7352 session (cabinet on a hollow curb, one size row, plan display
 * "both"), with made-up names and values.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MeshCache } from "@permitzip/bim-geometry";
import {
  buildSheetSceneFor,
  commandSchema,
  DEFAULT_SETTINGS,
  frameForViewport,
  isKind,
  partMesh,
  partTypeIssues,
  planCommit,
  setPartMeshProvider,
  type ModelState,
  type PartTypeDefinition,
  type Primitive,
} from "@permitzip/bim-kernel";
import { nodeManifoldEngine } from "../../bim-geometry/testing/node-manifold";
import { nodeNoteFonts } from "../src/pdf";
import { renderSheetPdfWith } from "../src/pdf-core";

const FT = 304.8;
const NOW = () => "2026-10-23T00:00:00.000Z";
let seq = 0;
const actor = { id: "avery", name: "Avery", kind: "human" as const };

function commit(head: ModelState, command: { readonly type: string } & Record<string, unknown>): ModelState {
  seq += 1;
  const d = planCommit(head, [], { idempotencyKey: `cpp-${seq}`, baseRevision: head.revision, actor, command: commandSchema.parse(command) }, NOW);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

const RTU: PartTypeDefinition = JSON.parse(readFileSync(path.join(__dirname, "fixtures/cut-sheet-rtu.json"), "utf8"));

function roofModel(): ModelState {
  let m: ModelState = { modelId: "cpp", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = commit(m, { type: "create_level", levelId: "roof", name: "Roof", elevationMm: 14 * FT });
  m = commit(m, { type: "place_part", partId: "rtu-1", typeId: "type-rtu", partType: RTU, levelId: "roof", position: { x: 10 * FT, y: 10 * FT }, mark: "RTU-1", values: {} });
  m = commit(m, { type: "create_view", viewId: "v-roof", name: "Roof plan", viewType: "floor_plan", props: { level: "roof" } });
  m = commit(m, { type: "create_view", viewId: "v-3d", name: "RTU 3D", viewType: "three_d" });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Roof" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-plan", sheetId: "s-1", viewId: "v-roof", center: { x: 200, y: 250 }, scale: 48 });
  m = commit(m, { type: "place_viewport", viewportId: "vp-3d", sheetId: "s-1", viewId: "v-3d", center: { x: 550, y: 250 } });
  return m;
}

function linesIn(m: ModelState, vpId: string): number {
  const vp = m.elements[vpId];
  if (!vp || vp.kind !== "viewport") throw new Error("no viewport");
  const view = m.elements[vp.viewId];
  if (!view || !isKind(view, "view")) throw new Error("no view");
  const frame = frameForViewport(m, vp, view);
  const inFrame = (q: { x: number; y: number }) => Math.abs(q.x - frame.center.x) <= frame.size.x / 2 + 0.01 && Math.abs(q.y - frame.center.y) <= frame.size.y / 2 + 0.01;
  return buildSheetSceneFor(m, "s-1", { projectName: "Test" }).primitives.filter((p: Primitive) => p.kind === "line" && inFrame(p.a) && inFrame(p.b)).length;
}

describe("a part drafted from a cut sheet prints (#20)", () => {
  beforeAll(async () => {
    setPartMeshProvider(new MeshCache(await nodeManifoldEngine()));
  });

  it("checks clean and meshes", () => {
    expect(partTypeIssues(RTU)).toEqual([]);
    expect(partMesh(RTU).triangleCount).toBeGreaterThan(0);
  });

  it("draws in a plan and in a saved 3D view on a sheet, and prints", async () => {
    const m = roofModel();
    expect(linesIn(m, "vp-plan")).toBeGreaterThan(4);
    // The saved 3D view (it has a camera) projected only primitive pieces and dropped the mesh: 0 lines before the fix.
    expect(linesIn(m, "vp-3d")).toBeGreaterThan(8);
    const scene = buildSheetSceneFor(m, "s-1", { projectName: "Test" });
    const pdf = await renderSheetPdfWith(scene, { title: "M-101", modelRevision: scene.revision, snapshotSha256: "test", renderer: "test" }, null, nodeNoteFonts());
    expect(pdf.bytes.byteLength).toBeGreaterThan(1000);
  });

  it("a 3D crop box through the cabinet still draws what is inside it", () => {
    let m = roofModel();
    const v = m.elements["v-3d"];
    if (!v || v.kind !== "view" || !v.props?.cropBox3d) throw new Error("no 3D box");
    const box = v.props.cropBox3d;
    m = commit(m, { type: "set_3d_crop_box", viewId: "v-3d", box: { ...box, center: { ...box.center, z: 14 * FT + 600 }, halfSize: { ...box.halfSize, z: 400 } } });
    expect(linesIn(m, "vp-3d")).toBeGreaterThan(4);
  });
});
