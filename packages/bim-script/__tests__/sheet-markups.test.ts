/**
 * @jest-environment node
 */
import { DEFAULT_SETTINGS, SHEET_MARKUPS_FEATURE, documentIndex, executeCommand, withUpgradePolicy, type Command, type ModelState, type Revision } from "@permitzip/bim-kernel";
import { MAX_SCRIPT_RENDERS, checkScriptSource, defineScript, markups, runScript, searchReference, sliceModel } from "../src/index";

const FEATURES = [SHEET_MARKUPS_FEATURE] as const;

function runCmd(model: ModelState, cmd: Command): ModelState {
  const r = withUpgradePolicy((f) => f === SHEET_MARKUPS_FEATURE, () => executeCommand(model, cmd));
  if (!r.ok) throw new Error(`${cmd.type}: ${r.error.message}`);
  return r.model;
}

function makeModel(): ModelState {
  let m: ModelState = { modelId: "script-markups-test", revision: 0 as Revision, elements: {}, connections: [], settings: DEFAULT_SETTINGS };
  m = runCmd(m, { type: "create_level", levelId: "lvl-1", name: "Level 1", elevationMm: 0 });
  m = runCmd(m, { type: "create_view", viewId: "view-mech", name: "Level 1 Mechanical", viewType: "floor_plan", props: { level: "Level 1", scale: 48 } });
  m = runCmd(m, { type: "create_sheet", sheetId: "sheet-m101", number: "M-101", name: "MECHANICAL PLAN" });
  m = runCmd(m, { type: "place_viewport", viewportId: "vp-mech", sheetId: "sheet-m101", viewId: "view-mech", center: { x: 300, y: 250 } });
  m = runCmd(m, {
    type: "add_sheet_markup",
    itemId: "mk-1",
    sheetId: "sheet-m101",
    points: [{ x: 280, y: 230 }, { x: 320, y: 270 }],
    markup: { tool: "marker", color: "#dc2626", widthMm: 2.4, status: "open", note: "Shift branch duct" },
  });
  return m;
}

describe("bim-script markups kit & ctx.render", () => {
  it("lists marked sheets, reads markups, and queues renders in a read-only script", async () => {
    const model = makeModel();
    const script = defineScript({
      kind: "layout",
      reads: { kinds: ["sheet", "viewport", "view", "drawing_item"] },
      parameters: {},
      run(ctx) {
        const sheets = markups.sheetsWithMarkups(ctx);
        const items = markups.list(ctx, "M-101");
        markups.renderSheet(ctx, "M-101", { focusStatus: "open", monochromeSheet: true });
        ctx.report("sheets", sheets);
        ctx.report("items", items);
      },
    });
    const output = await runScript(script, { slice: sliceModel(model, script.manifest.reads, [], FEATURES), values: {}, scriptHash: "test-1" });
    expect(output.kind).toBe("edits");
    if (output.kind !== "edits") return;
    expect(output.steps).toBe(0);
    expect(output.renders).toHaveLength(1);
    expect(output.renders![0]!.kind).toBe("sheet");
    expect(output.renders![0]!.targetId).toBe("sheet-m101");
    expect(output.renders![0]!.monochromeSheet).toBe(true);
    expect(output.renders![0]!.regionMm).toBeDefined();
    const sheetsReport = output.report?.find((r) => r.label === "sheets");
    const sheets = sheetsReport?.value as Array<{ number: string; openCount: number }>;
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.number).toBe("M-101");
    expect(sheets[0]!.openCount).toBe(1);
  });

  it("can add, yellow-line (markAddressed), and clear markups through kernel commands", async () => {
    const model = makeModel();
    const script = defineScript({
      kind: "layout",
      reads: { kinds: ["sheet", "drawing_item"] },
      parameters: {},
      run(ctx) {
        ctx.label("Mark up and yellow-line M-101");
        markups.markAddressed(ctx, ["mk-1"], { note: "Moved branch duct 18 inches north" });
        const added = markups.add(ctx, "M-101", {
          points: [{ x: 100, y: 100 }, { x: 160, y: 130 }],
          color: "#9333ea",
          tool: "marker",
          note: "Verify diffuser CFM",
        });
        ctx.report("added", added);
      },
    });
    const output = await runScript(script, { slice: sliceModel(model, script.manifest.reads, [], FEATURES), values: {}, scriptHash: "test-2" });
    expect(output.kind).toBe("edits");
    if (output.kind !== "edits") return;
    expect(output.batches).toHaveLength(1);
    const applied = withUpgradePolicy((f) => f === SHEET_MARKUPS_FEATURE, () => executeCommand(model, output.batches[0]!));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const list = documentIndex(applied.model).markupsBySheet.get("sheet-m101") ?? [];
    expect(list).toHaveLength(2);
    expect(list.find((i) => i.id === "mk-1")?.markup?.status).toBe("addressed");
    expect(list.find((i) => i.id === "mk-1")?.markup?.addressedNote).toBe("Moved branch duct 18 inches north");
  });

  it("caps render requests per script run at MAX_SCRIPT_RENDERS", async () => {
    const model = makeModel();
    const script = defineScript({
      kind: "layout",
      reads: { kinds: ["sheet", "drawing_item"] },
      parameters: {},
      run(ctx) {
        for (let i = 0; i < 8; i++) {
          markups.renderSheet(ctx, "M-101", { label: `Render ${i}` });
        }
      },
    });
    await expect(
      runScript(script, { slice: sliceModel(model, script.manifest.reads, [], FEATURES), values: {}, scriptHash: "test-3" }),
    ).rejects.toThrow(/at most 6/i);
    expect(MAX_SCRIPT_RENDERS).toBe(6);
  });

  it("passes script source check and is discoverable via bim_script_reference", () => {
    const source = `
import { defineScript, markups } from "@permitzip/bim-script";
export default defineScript({
  kind: "layout",
  reads: { kinds: ["sheet", "viewport", "view", "drawing_item"] },
  parameters: {},
  run(ctx) {
    const list = markups.sheetsWithMarkups(ctx);
    markups.renderAllMarkedSheets(ctx, { monochromeSheet: true });
    ctx.report("sheets", list);
  },
});
`;
    const checked = checkScriptSource(source);
    expect(checked).toEqual([]);
    const hits = searchReference("redline");
    expect(hits.some((e) => e.name.startsWith("markups."))).toBe(true);
  });
});
