/**
 * @jest-environment node
 *
 * Round 16 B2 (review video, Nov 6, 02:19 and 34:54): "mutiny should be out
 * of the box with its own title block that looks way cooler." MutinyBIM ships
 * a branded 24×36 and 30×42 in its built-in library: drawable by the sheet
 * engine, its fonts served with MutinyBIM, no firm's or client's content in
 * it, the firm line and consultants filled from the project's parameters.
 * Fails on round 15's code: the built-in library had no title blocks.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { buildSheetSceneFor, commandSchema, executeCommand, titleBlockDefinitionSchema, withUpgradePolicy, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";
import { MUTINYBIM_TITLE_BLOCK_D_ID, MUTINYBIM_TITLE_BLOCK_E1_ID, builtinLibraryBundle, mutinybimTitleBlockItems } from "../src";

const PUBLIC = path.join(__dirname, "..", "..", "..", "public");

function run(model: ModelState, command: Record<string, unknown> & { type: string }): ModelState {
  const r = withUpgradePolicy(() => true, () => executeCommand(model, commandSchema.parse(command)));
  if (!r.ok) throw new Error(r.error.message);
  return { ...r.model, revision: (model.revision + 1) as ModelState["revision"] };
}

describe("b2: MutinyBIM's own title blocks", () => {
  const items = mutinybimTitleBlockItems();

  it("the built-in library carries a 24×36 and a 30×42, each drawable", () => {
    const shipped = (builtinLibraryBundle().titleBlocks ?? []).flatMap((t) => (typeof t === "object" && t !== null && "id" in t && typeof t.id === "string" ? [t.id] : []));
    expect(shipped).toEqual(expect.arrayContaining([MUTINYBIM_TITLE_BLOCK_D_ID, MUTINYBIM_TITLE_BLOCK_E1_ID]));
    for (const item of items) {
      const def = titleBlockDefinitionSchema.parse(item.definition);
      expect(item.paperSizes).toEqual([def.paperName]);
      for (const font of Object.values(def.fonts)) expect(existsSync(path.join(PUBLIC, font.file))).toBe(true);
    }
  });

  it("holds no firm's content: the firm line and consultants come from the project", () => {
    expect(JSON.stringify(items).toLowerCase()).not.toMatch(/permitzip|richmond|@/);
    const item = items.find((t) => t.id === MUTINYBIM_TITLE_BLOCK_D_ID);
    if (!item) throw new Error("no 24x36");
    const row = { id: item.id, revision: item.revision, name: item.name, definition: titleBlockDefinitionSchema.parse(item.definition) };
    let m = run(createDemoModel(), { type: "create_sheet", sheetId: "s1", number: "M-101", name: "Level 1 plan", titleBlockRow: row });
    m = run(m, { type: "set_project_parameters", values: { firm_name: "Acme Engineering", architect: "Example Architects, Norfolk", date: "2026-11-06", status: "Issued for permit" } });
    const texts = buildSheetSceneFor(m, "s1", { projectName: "Sample School" }).primitives.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(texts).toEqual(expect.arrayContaining(["MUTINY", "ACME ENGINEERING", "Example Architects, Norfolk", "11/06/2026", "ISSUED FOR PERMIT", "SAMPLE SCHOOL", "M-101"]));
  });
});
