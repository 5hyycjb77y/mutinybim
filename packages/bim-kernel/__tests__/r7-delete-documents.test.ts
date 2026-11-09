/**
 * @jest-environment node
 *
 * delete_elements and what points at a view or sheet: a sheet's viewports and
 * notes, a view's viewport and notes go with it on cascade, a placed view is
 * refused by default (as delete_view is), and a sheet that stays stops
 * listing the view. Before, delete_elements removed the view or sheet and left
 * its viewports and notes pointing at nothing (the Building Model specs' 9071
 * model, Oct 31: 12 viewports and 40 notes whose owner was gone).
 */
import { planCommit, type Command, type CommandRequest, type ModelState } from "../src";
import { createDemoModel } from "@permitzip/bim-pack-mechanical/seed";

const FT = 304.8;
const NOW = () => "2026-10-31T00:00:00.000Z";
let n = 0;

function attempt(head: ModelState, command: Command) {
  n += 1;
  const req: CommandRequest = { idempotencyKey: `r7-del-docs-${n}-key`, baseRevision: head.revision, actor: { id: "a", name: "Agent", kind: "agent" }, command };
  return planCommit(head, [], req, NOW);
}

function commit(head: ModelState, command: Command): ModelState {
  const d = attempt(head, command);
  if (!d.ok) throw new Error(`${command.type} refused: ${d.error.message}`);
  return d.model;
}

function placedPlan(): ModelState {
  let m = createDemoModel();
  m = commit(m, { type: "create_view", viewId: "v-plan", name: "Level 1 Plan", viewType: "floor_plan", crop: { min: { x: 0, y: 0 }, max: { x: 40 * FT, y: 30 * FT } }, props: { level: "L1", scale: 48 } });
  m = commit(m, { type: "create_sheet", sheetId: "s-1", number: "M-101", name: "Plan" });
  m = commit(m, { type: "place_viewport", viewportId: "vp-1", sheetId: "s-1", viewId: "v-plan", center: { x: 300, y: 250 } });
  m = commit(m, { type: "add_drawing_item", itemId: "note-sheet", ownerId: "s-1", shape: "text", points: [{ x: 50, y: 50 }], text: "General notes" });
  m = commit(m, { type: "add_drawing_item", itemId: "note-view", ownerId: "v-plan", shape: "text", points: [{ x: 1000, y: 1000 }], text: "Verify in field" });
  return m;
}

const live = (m: ModelState, id: string): boolean => {
  const el = m.elements[id];
  return el !== undefined && !("deleted" in el && el.deleted === true);
};

describe("r7 delete_elements with views and sheets", () => {
  test("cascade on a sheet takes its viewports and notes", () => {
    const m = commit(placedPlan(), { type: "delete_elements", ids: ["s-1"], policy: "cascade" });
    expect(live(m, "s-1")).toBe(false);
    expect(live(m, "vp-1")).toBe(false);
    expect(live(m, "note-sheet")).toBe(false);
    expect(live(m, "v-plan")).toBe(true);
  });

  test("a placed view is refused by default, naming what points at it", () => {
    const d = attempt(placedPlan(), { type: "delete_elements", ids: ["v-plan"], policy: "refuse" });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.message).toMatch(/Nothing deleted/);
  });

  test("cascade on a view takes its viewport and notes, and the sheet stops listing it", () => {
    const m = commit(placedPlan(), { type: "delete_elements", ids: ["v-plan"], policy: "cascade" });
    expect(live(m, "v-plan")).toBe(false);
    expect(live(m, "vp-1")).toBe(false);
    expect(live(m, "note-view")).toBe(false);
    const sheet = m.elements["s-1"];
    expect(sheet?.kind === "sheet" ? sheet.viewIds : null).toEqual([]);
  });
});
