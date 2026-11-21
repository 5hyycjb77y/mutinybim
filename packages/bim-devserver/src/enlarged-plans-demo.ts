import { enlargedPlanCommands, executeCommand, type Command, type ModelState } from "@permitzip/bim-kernel";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

/**
 * Enlarged plans, sections and elevations showcase: overall Level 1 plan with
 * a live parametric enlarged-plan callout (1 / M-401), a building section cut
 * mark (1 / M-301), and an equipment elevation marker (2 / M-401), all wired
 * to sheets M-101, M-301 and M-401 so moving any viewport updates the bubbles.
 */
export function enlargedPlansDemoModel(): ModelState {
  const FT = 304.8;
  let m = createDemoModel("enlarged-plans");
  const apply = (cmd: Command) => {
    const r = executeCommand(m, cmd);
    if (!r.ok) throw new Error(`[bim-devserver] enlarged-plans model: ${cmd.type}: ${r.error.message}`);
    m = { ...r.model, revision: (m.revision + 1) as ModelState["revision"] };
  };
  const setup: Command[] = [
    // createDemoModel puts its RTU, supply trunk, branches and diffusers on DEFAULT_PARTITION.level ("L1").
    { type: "create_level", levelId: "lvl-1", name: "L1", elevationMm: 0 },
    { type: "create_level", levelId: "lvl-roof", name: "Roof", elevationMm: 14 * FT },
    {
      type: "create_view",
      viewId: "v-overall",
      name: "Level 1 - Overall Mechanical",
      viewType: "floor_plan",
      crop: { min: { x: -12 * FT, y: -10 * FT }, max: { x: 48 * FT, y: 20 * FT } },
      props: { level: "L1", scale: 96, discipline: "mechanical" },
    },
    {
      type: "create_view",
      viewId: "v-section-a",
      name: "Section A-A (Supply Trunk)",
      viewType: "section",
      props: {
        level: "L1",
        scale: 48,
        section: { start: { x: -6 * FT, y: -5 * FT }, end: { x: 44 * FT, y: -5 * FT }, direction: 1, depthMm: 22 * FT },
      },
    },
    {
      type: "create_view",
      viewId: "v-elev-north",
      name: "Branch 1 North Elevation",
      viewType: "elevation",
      props: {
        level: "L1",
        scale: 24,
        section: { start: { x: 10 * FT, y: 4 * FT }, end: { x: 22 * FT, y: 4 * FT }, direction: 1, depthMm: 12 * FT },
      },
    },
  ];
  for (const cmd of setup) apply(cmd);

  const enlargedSteps = enlargedPlanCommands(m, {
    parentViewId: "v-overall",
    viewId: "v-enlarged-branch",
    calloutId: "co-enlarged-branch",
    name: "Enlarged Branch 1 Plan",
    box: { min: { x: 8 * FT, y: -3 * FT }, max: { x: 24 * FT, y: 14 * FT } },
    scale: 24,
  });
  if (typeof enlargedSteps === "string") throw new Error(`[bim-devserver] enlarged-plans model: ${enlargedSteps}`);
  apply({ type: "batch_documents", label: "Create enlarged branch plan", commands: enlargedSteps });

  const sheets: Command[] = [
    { type: "create_sheet", sheetId: "s-m101", number: "M-101", name: "Overall Mechanical Plan" },
    { type: "place_viewport", viewportId: "vp-overall", sheetId: "s-m101", viewId: "v-overall", center: { x: 420, y: 300 }, scale: 96 },
    { type: "create_sheet", sheetId: "s-m301", number: "M-301", name: "Mechanical Sections" },
    { type: "place_viewport", viewportId: "vp-sec-a", sheetId: "s-m301", viewId: "v-section-a", center: { x: 420, y: 300 }, scale: 48 },
    { type: "create_sheet", sheetId: "s-m401", number: "M-401", name: "Enlarged Plans & Elevations" },
    { type: "place_viewport", viewportId: "vp-enlarged", sheetId: "s-m401", viewId: "v-enlarged-branch", center: { x: 230, y: 300 }, scale: 24 },
    { type: "place_viewport", viewportId: "vp-elev-north", sheetId: "s-m401", viewId: "v-elev-north", center: { x: 600, y: 300 }, scale: 24 },
  ];
  for (const cmd of sheets) apply(cmd);
  return m;
}
