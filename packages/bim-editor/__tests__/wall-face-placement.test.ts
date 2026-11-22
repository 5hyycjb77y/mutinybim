/** @jest-environment node */
import {
  DEFAULT_SETTINGS,
  PARTS_WALL_FACE_HOST_FEATURE,
  VIEW_SYMBOL_SCALE_FEATURE,
  buildViewScene,
  builtinPartType,
  executeCommand,
  modelToPaperPoint,
  viewOnPaper,
  withUpgradePolicy,
  type Command,
  type ModelState,
  type Revision,
} from "@permitzip/bim-kernel";
import { installFirstPartyAddOns } from "@permitzip/bim-first-party";
import { CLIENT_FEATURES, SERVER_FEATURES } from "@permitzip/bim-sync";
import { drawingPlacementCommand, drawingPlacementTarget, isWallFaceMountable } from "../src/editor/placement";

installFirstPartyAddOns();

const FT = 304.8;

function runCmds(cmds: readonly Command[]): ModelState {
  let m: ModelState = { modelId: "editor-wall-snap", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  return withUpgradePolicy(() => true, () => {
    for (const c of cmds) {
      const r = executeCommand(m, c);
      if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
      m = { ...r.model, revision: (m.revision + 1) as Revision };
    }
    return m;
  });
}

describe("editor wall-face placement snapping and protocol feature advertisement", () => {
  it("advertises parts:wall_face_host and graphics:symbol_scale on both client and server", () => {
    expect(CLIENT_FEATURES).toContain(PARTS_WALL_FACE_HOST_FEATURE);
    expect(SERVER_FEATURES).toContain(PARTS_WALL_FACE_HOST_FEATURE);
    expect(CLIENT_FEATURES).toContain(VIEW_SYMBOL_SCALE_FEATURE);
    expect(SERVER_FEATURES).toContain(VIEW_SYMBOL_SCALE_FEATURE);
  });

  it("identifies wall-mountable parts and snaps plan placement flush to the wall finish face with wall_face host", () => {
    const duplex = builtinPartType("builtin:duplex-receptacle@1")!;
    const sw = builtinPartType("builtin:switch-single-pole@1")!;
    const panel = builtinPartType("builtin:panelboard-225@1")!;
    const troffer = builtinPartType("builtin:troffer-2x4-led@1")!;
    const occ = builtinPartType("builtin:occupancy-sensor-ceiling@1")!;

    expect(isWallFaceMountable(duplex.definition)).toBe(true);
    expect(isWallFaceMountable(sw.definition)).toBe(true);
    expect(isWallFaceMountable(panel.definition)).toBe(true);
    expect(isWallFaceMountable(troffer.definition)).toBe(false);
    expect(isWallFaceMountable(occ.definition)).toBe(false);

    const model = runCmds([
      { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 },
      {
        type: "add_architecture",
        levelId: "L1",
        walls: [{ wallId: "w-south", start: { x: 0, y: 0 }, end: { x: 20 * FT, y: 0 }, thicknessMm: 152.4, heightMm: 3048 }],
        openings: [],
        casework: [],
        rooms: [],
      },
      {
        type: "create_view",
        viewId: "v-e101",
        name: "E101",
        viewType: "floor_plan",
        crop: { min: { x: -2 * FT, y: -2 * FT }, max: { x: 22 * FT, y: 12 * FT } },
        props: { level: "Level 1", scale: 96, discipline: "electrical" },
      },
    ]);

    const view = model.elements["v-e101"];
    if (view?.kind !== "view") throw new Error("expected view");
    const { frame } = buildViewScene(model, "v-e101");
    const vop = viewOnPaper(model, view, frame);

    // Pointer inside room near south wall -> snaps flush to north (interior) finish face at y = +3" (76.2 mm), rot 0.
    const paper = modelToPaperPoint(vop, { x: 5 * FT, y: 0.5 * FT, z: 457.2 });
    const snapped = drawingPlacementTarget(model, vop, paper, 457.2, undefined, { wallSnap: true });
    expect(snapped.ok).toBe(true);
    if (!snapped.ok) return;
    expect(snapped.target.host).toEqual({ kind: "wall_face", elementId: "w-south", stationMm: 5 * FT, side: 1 });
    expect(snapped.target.position.y).toBeCloseTo(76.2, 1);
    expect(snapped.target.rotationDeg).toBe(0);

    const cmd = drawingPlacementCommand(
      { kind: "new", typeId: duplex.id, definition: duplex.definition, inModel: false, heightMm: 457.2, rotationDeg: 90 },
      snapped.target,
      "p-ui-snap",
    );
    expect(cmd.type === "place_part" && cmd.host?.kind === "wall_face").toBe(true);
    expect(cmd.type === "place_part" && cmd.rotationDeg).toBe(0);
  });
});
