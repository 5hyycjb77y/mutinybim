/**
 * @jest-environment node
 *
 * Charts and pictures on sheets. Before, a sheet held views, notes and
 * linework only: the Hunter curve chart lived in a Plumbing tab dialog and a
 * logo or photo couldn't go on paper at all (`add_drawing_item` had no
 * "figure" shape). Now a figure is an ordinary drawing item on the sheet:
 * placed, moved and resized by undoable commands, the chart redrawn live
 * from the model on every build, a picture embedded in the printed PDF.
 */
import { DEFAULT_SETTINGS, buildSheetSceneFor, documentIndex, modifyCommand, planCommit, registerChartKind, sceneToSvg, type Changeset, type Command, type DrawingItem, type ModelState } from "@permitzip/bim-kernel";
import { BIM_CALC_CHART_KINDS } from "@permitzip/bim-pack-plumbing";
import { sampleMarketLoadPointCommand, sampleMarket } from "../../bim-kernel/__tests__/fixtures/sample-market";
import { renderSheetPdfWith } from "../src/pdf-core";

/** A 1 x 1 white PNG. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64"));
const IMAGE = { kind: "image" as const, image: { fileId: "f-logo", name: "Firm logo.png", mime: "image/png" as const } };
const CHART = { kind: "chart" as const, chart: "plumbing.hunter_curve" };

let log: Changeset[] = [];
function commit(head: ModelState, command: Command): ModelState {
  const d = planCommit(head, [], { idempotencyKey: `k-${head.revision}-${command.type}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-25T07:00:00.000Z", log);
  if (!d.ok) throw new Error(`${command.type}: ${d.error.message}`);
  log.push(d.changeset);
  return d.model;
}
function refused(head: ModelState, command: Command): string {
  const d = planCommit(head, [], { idempotencyKey: `r-${head.revision}`, baseRevision: head.revision, actor: { id: "avery", name: "Avery", kind: "human" }, command }, () => "2026-10-25T07:00:00.000Z", log);
  if (d.ok) throw new Error(`${command.type} was saved`);
  return d.error.message;
}

function sheetWithFigures(): ModelState {
  log = [];
  let m: ModelState = { modelId: "7492", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  const build = sampleMarket();
  for (const c of build.setup) m = commit(m, c);
  m = commit(m, sampleMarketLoadPointCommand(build.points));
  m = commit(m, { type: "save_catalog_entry", entry: { type: "plumbing_settings", name: "Project", sizingMode: "check", buildingType: "restaurant" } });
  m = commit(m, { type: "create_sheet", sheetId: "s-p1", number: "P-001", name: "Plumbing schedules" });
  m = commit(m, { type: "add_drawing_item", itemId: "fig-hunter", ownerId: "s-p1", shape: "figure", points: [{ x: 500, y: 300 }, { x: 700, y: 440 }], figure: CHART });
  return commit(m, { type: "add_drawing_item", itemId: "fig-logo", ownerId: "s-p1", shape: "figure", points: [{ x: 40, y: 40 }, { x: 100, y: 70 }], figure: IMAGE });
}

const item = (m: ModelState, id: string) => m.elements[id] as DrawingItem;
const texts = (m: ModelState) => buildSheetSceneFor(m, "s-p1", { projectName: "7492" }).primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));

beforeAll(() => {
  for (const kind of BIM_CALC_CHART_KINDS) registerChartKind(kind);
});

describe("figures on sheets", () => {
  it("draws the Hunter chart live from the model inside its frame, and lists the picture for print", () => {
    const m = sheetWithFigures();
    expect(texts(m)).toEqual(expect.arrayContaining(["Modified Hunter's curve (estimated demand)", "Domestic Cold Water: 43.25 WSFU, 48 gpm"]));
    const scene = buildSheetSceneFor(m, "s-p1", { projectName: "7492" });
    expect(scene.images).toEqual([{ itemId: "fig-logo", fileId: "f-logo", name: "Firm logo.png", mime: "image/png", at: { x: 40, y: 40 }, size: { x: 60, y: 30 } }]);
    expect(sceneToSvg(scene, { imageHref: (id) => (id === "f-logo" ? "https://x/logo.png" : null) })).toContain('<image x="40.00" y="40.00" width="60.00" height="30.00" href="https://x/logo.png"');
    expect(sceneToSvg(scene)).toContain("Firm logo.png (loading)");
  });

  it("moves with the Move tool and resizes by its corners, each one undo", () => {
    let m = sheetWithFigures();
    const items = documentIndex(m).itemsByOwner.get("s-p1") ?? [];
    const moved = modifyCommand(items, ["fig-hunter"], { op: "move", delta: { x: -100, y: 20 } }, "s-p1", "mv");
    if (!moved.ok) throw new Error(moved.reason);
    m = commit(m, moved.command);
    expect(item(m, "fig-hunter").points).toEqual([{ x: 400, y: 320 }, { x: 600, y: 460 }]);
    m = commit(m, { type: "update_drawing_item", itemId: "fig-hunter", points: [{ x: 400, y: 320 }, { x: 650, y: 500 }] });
    const resize = log[log.length - 1];
    expect(item(m, "fig-hunter").points[1]).toEqual({ x: 650, y: 500 });
    m = commit(m, { type: "undo", revision: resize?.revision ?? 0 });
    expect(item(m, "fig-hunter").points[1]).toEqual({ x: 600, y: 460 });
  });

  it("changes what a figure shows: another chart setting, or a different picture", () => {
    let m = sheetWithFigures();
    m = commit(m, { type: "update_drawing_item", itemId: "fig-hunter", figure: { ...CHART, params: { curves: "ashrae_a" }, title: "WATER DEMAND" } });
    expect(texts(m)).toContain("WATER DEMAND");
    m = commit(m, { type: "update_drawing_item", itemId: "fig-logo", figure: { kind: "image", image: { fileId: "f-photo", name: "Site photo.jpg", mime: "image/jpeg" } } });
    expect(buildSheetSceneFor(m, "s-p1", { projectName: "7492" }).images?.[0]?.fileId).toBe("f-photo");
  });

  it("refuses a figure off a sheet, without its chart or picture, or too small to see", () => {
    const m = commit(sheetWithFigures(), { type: "create_view", viewId: "v-d", name: "Detail", viewType: "detail" });
    expect(refused(m, { type: "add_drawing_item", itemId: "f2", ownerId: "v-d", shape: "figure", points: [{ x: 0, y: 0 }, { x: 50, y: 50 }], figure: CHART })).toBe("Charts and pictures go on a sheet.");
    expect(refused(m, { type: "add_drawing_item", itemId: "f3", ownerId: "s-p1", shape: "figure", points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] })).toBe("A figure needs its chart or picture.");
    expect(refused(m, { type: "add_drawing_item", itemId: "f4", ownerId: "s-p1", shape: "figure", points: [{ x: 0, y: 0 }, { x: 0.2, y: 0.2 }], figure: CHART })).toMatch(/too small to see/);
    expect(refused(m, { type: "add_drawing_item", itemId: "f5", ownerId: "s-p1", shape: "rect", points: [{ x: 0, y: 0 }, { x: 50, y: 50 }], figure: CHART })).toBe("Only a figure takes a chart or picture.");
  });

  it("prints: the picture is embedded in the PDF, and a sheet whose picture can't be loaded is refused in words", async () => {
    const scene = buildSheetSceneFor(sheetWithFigures(), "s-p1", { projectName: "7492" });
    const meta = { title: "P-001", modelRevision: scene.revision, snapshotSha256: "x", renderer: "test" };
    const loaded: string[] = [];
    const pdf = await renderSheetPdfWith(scene, meta, null, null, { load: async (id) => (loaded.push(id), PNG) });
    expect(loaded).toEqual(["f-logo"]);
    expect(Buffer.from(pdf.bytes).toString("latin1")).toMatch(/\/Subtype \/Image/);
    await expect(renderSheetPdfWith(scene, meta, null, null)).rejects.toThrow("This sheet has a picture (Firm logo.png), and pictures can't be loaded here, so it can't be printed");
    await expect(renderSheetPdfWith(scene, meta, null, null, { load: async () => Promise.reject(new Error("gone")) })).rejects.toThrow("The picture Firm logo.png couldn't be loaded for printing: gone");
  });
});
