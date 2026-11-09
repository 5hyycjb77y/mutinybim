/**
 * @jest-environment node
 *
 * Undo walks back through your own edits in order. A later edit you have
 * already undone no longer stands between an earlier one and its undo:
 * add 2 planned items, place one, undo the place, undo the add (Equipment
 * list › Add, found by hand on 7903, Oct 27). Edits still standing, yours or
 * someone else's, keep refusing.
 */
import type { Command } from "../src";
import { Building, TYPES } from "./fixtures/electrical-building";

const ADD: Command = {
  type: "batch_edits",
  label: "Add 2 planned items from the equipment list",
  commands: [
    { type: "plan_part", partId: "k1", typeId: "type-panel208", partType: TYPES.panel208, mark: "K-1" },
    { type: "plan_part", partId: "k2", typeId: "type-panel208", mark: "K-2" },
  ],
};

describe("undo after undo", () => {
  it("undoes the add once the place that followed it has been undone", () => {
    const b = new Building();
    const add = b.ok(ADD);
    const place = b.ok({ type: "place_planned_part", partId: "k1", levelId: "lvl-1", position: { x: 3000, y: 0 } });
    b.ok({ type: "undo", revision: place.revision });
    expect(b.head.elements.k1).toBeDefined();
    b.ok({ type: "undo", revision: add.revision });
    expect(b.head.elements.k1).toBeUndefined();
    expect(b.head.elements.k2).toBeUndefined();
  });

  it("walks back three of your own edits in a row", () => {
    const b = new Building();
    const add = b.ok(ADD);
    const place = b.ok({ type: "place_planned_part", partId: "k1", levelId: "lvl-1", position: { x: 3000, y: 0 } });
    const move = b.ok({ type: "move_elements", ids: ["k1"], delta: { x: 500, y: 0 } });
    b.ok({ type: "undo", revision: move.revision });
    b.ok({ type: "undo", revision: place.revision });
    b.ok({ type: "undo", revision: add.revision });
    expect(b.head.elements.k1).toBeUndefined();
  });

  it("still refuses while a later edit stands", () => {
    const b = new Building();
    const add = b.ok(ADD);
    b.ok({ type: "place_planned_part", partId: "k1", levelId: "lvl-1", position: { x: 3000, y: 0 } });
    expect(b.refused({ type: "undo", revision: add.revision })).toMatch(/undo that first/);
  });

  it("still refuses when someone else changed it, even after you undid your own later edit", () => {
    const b = new Building();
    const add = b.ok(ADD);
    const place = b.ok({ type: "place_planned_part", partId: "k1", levelId: "lvl-1", position: { x: 3000, y: 0 } });
    b.ok({ type: "set_parameters", id: "k2", scope: "instance", values: { panel_name: "Casey's" } }, "casey");
    b.ok({ type: "undo", revision: place.revision });
    expect(b.refused({ type: "undo", revision: add.revision })).toMatch(/casey changed this since/);
  });

  it("an undo that is itself undone (redo) stands again", () => {
    const b = new Building();
    const add = b.ok(ADD);
    const place = b.ok({ type: "place_planned_part", partId: "k1", levelId: "lvl-1", position: { x: 3000, y: 0 } });
    const undoPlace = b.ok({ type: "undo", revision: place.revision });
    b.ok({ type: "undo", revision: undoPlace.revision });
    expect(b.refused({ type: "undo", revision: add.revision })).toMatch(/undo that first/);
  });
});
