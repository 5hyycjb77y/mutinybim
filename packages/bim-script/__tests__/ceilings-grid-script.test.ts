/**
 * @jest-environment node
 *
 * `@permitzip/bim-script` exposure for real-scale configurable ceiling tile
 * grids (`building.ceiling` with `grid`, `building.ceilingTileCenter`) and
 * sheet discipline/group/sortOrder metadata (`documents.sheet`, `documents.planView`).
 */
import {
  CEILINGS_FEATURE,
  DEFAULT_SETTINGS,
  TILE_2FT_MM,
  TILE_4FT_MM,
  planCommit,
  withUpgradePolicy,
  type Command,
  type ModelState,
} from "@permitzip/bim-kernel";
import { building, defineScript, documents, runScript, sliceModel, units } from "../src";

const FEATURES = [CEILINGS_FEATURE];
const peerReads = (f: string) => FEATURES.includes(f);

let seq = 0;
function commit(model: ModelState, command: Command): ModelState {
  const d = withUpgradePolicy(peerReads, () =>
    planCommit(
      model,
      [],
      {
        idempotencyKey: `cg-${++seq}`,
        baseRevision: model.revision,
        actor: { id: "avery", name: "Avery", kind: "human" },
        command,
      },
      () => "2026-11-22T00:00:00.000Z",
    ),
  );
  if (!d.ok) throw new Error(`${command.type}: ${d.error.code} — ${d.error.message}`);
  return d.model;
}

describe("bim-script ceiling tile grid & sheet grouping", () => {
  it("authors a 2'×4' ACT cloud ceiling, snaps 2'×4' and 2'×2' devices into exact tiles, and sets sheet grouping", async () => {
    let model: ModelState = { modelId: "m-cg", revision: 0 as ModelState["revision"], elements: {}, connections: [], settings: DEFAULT_SETTINGS };
    model = commit(model, { type: "create_level", levelId: "L1", name: "Level 1", elevationMm: 0 });

    let trofferMm = { x: 0, y: 0 };
    let diffuserMm = { x: 0, y: 0 };
    let clgId = "";
    let sheetId = "";

    const script = defineScript({
      kind: "layout",
      reads: { levels: true, kinds: ["ceiling", "view", "sheet"] },
      parameters: {},
      run(ctx) {
        clgId = building.ceiling(ctx, {
          level: "L1",
          outline: [
            { x: units.ft(0), y: units.ft(0) },
            { x: units.ft(16), y: units.ft(0) },
            { x: units.ft(16), y: units.ft(12) },
            { x: units.ft(0), y: units.ft(12) },
          ],
          height: units.ft(9.5),
          form: "cloud",
          grid: { preset: "2x4", origin: { x: units.ft(0), y: units.ft(0) } },
        });
        const t = building.ceilingTileCenter(ctx, { preset: "2x4", origin: { x: units.ft(0), y: units.ft(0) } }, { x: units.ft(5.2), y: units.ft(3.1) });
        const d = building.ceilingTileCenter(
          ctx,
          { preset: "2x4", origin: { x: units.ft(0), y: units.ft(0) } },
          { x: units.ft(1.1), y: units.ft(1.2) },
          { deviceWidth: units.in(24), deviceDepth: units.in(24) },
        );
        trofferMm = { x: units.in_(t.x, "mm"), y: units.in_(t.y, "mm") };
        diffuserMm = { x: units.in_(d.x, "mm"), y: units.in_(d.y, "mm") };

        const rcp = documents.planView(ctx, {
          id: "v-rcp",
          level: "L1",
          name: "L1 RCP",
          offsetStackedRuns: true,
          showReferenceDisciplines: ["architecture"],
        });
        sheetId = documents.sheet(ctx, {
          number: "A-104",
          name: "REFLECTED CEILING PLAN",
          discipline: "architecture",
          group: "Architectural",
          sortOrder: 104,
        });
        documents.place(ctx, sheetId, rcp, { x: units.mm(400), y: units.mm(300) });
      },
    });

    const out = await runScript(script, {
      slice: sliceModel(model, script.manifest.reads, [], FEATURES),
      values: {},
      scriptHash: "sha256:cg",
    });

    expect(out.kind).toBe("edits");
    if (out.kind !== "edits") throw new Error("expected edits");
    for (const c of out.batches) model = commit(model, c);

    const clg = model.elements[clgId];
    expect(clg?.kind).toBe("ceiling");
    if (clg?.kind === "ceiling") {
      expect(clg.grid).toEqual({
        spacingXMm: TILE_4FT_MM,
        spacingYMm: TILE_2FT_MM,
        origin: { x: 0, y: 0 },
      });
    }

    // Troffer snapped to col=1, row=1 center: (6 ft, 3 ft) = (1828.8 mm, 914.4 mm)
    expect(trofferMm.x).toBeCloseTo(1828.8, 1);
    expect(trofferMm.y).toBeCloseTo(914.4, 1);

    // 2'×2' diffuser snapped to left half of col=0, row=0 tile: (1 ft, 1 ft) = (304.8 mm, 304.8 mm)
    expect(diffuserMm.x).toBeCloseTo(304.8, 1);
    expect(diffuserMm.y).toBeCloseTo(304.8, 1);

    const sh = model.elements[sheetId];
    expect(sh?.kind).toBe("sheet");
    if (sh?.kind === "sheet") {
      expect(sh.props?.discipline).toBe("architecture");
      expect(sh.props?.group).toBe("Architectural");
      expect(sh.props?.sortOrder).toBe(104);
    }

    const rcp = model.elements["v-rcp"];
    expect(rcp?.kind).toBe("view");
    if (rcp?.kind === "view") {
      expect(rcp.props?.offsetStackedRuns).toBe(true);
      expect(rcp.props?.showReferenceDisciplines).toEqual(["architecture"]);
    }
  });
});
