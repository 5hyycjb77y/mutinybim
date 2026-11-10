/**
 * Small office: two floors of a 40 ft x 30 ft office.
 *
 * Each floor gets exterior walls, interior walls that split it into an open
 * office, a conference room and a private office, doors and windows, and
 * rooms found from the walls around them (nobody draws a room outline), and
 * a ceiling in each room. Then each floor gets a plan on its own sheet.
 *
 * Level arguments are level ids: building.level returns the id every call
 * below passes as `level`. On a model that already has levels, read them
 * (reads.levels: true) and pass an id from ctx.model.levels(); the kit's
 * helpers also take the name of exactly one level ("Level 2").
 *
 * Run it: paste it to an assistant connected to the MutinyBIM tool server
 * ("run this script"), or `npm run example -- small-office`.
 */
import { defineScript, units, building, documents } from "@permitzip/bim-script";

const ft = units.ft;
const at = (x: number, y: number) => ({ x: ft(x), y: ft(y) });

export default defineScript({
  kind: "layout",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    ctx.label("Small office: two floors with walls, rooms, ceilings, doors and windows, and a plan sheet per floor");
    const made: { level: string; id: string; rooms: string[] }[] = [];

    const floors = [
      { name: "Level 1", elevation: ft(0), sheet: "A-101" },
      { name: "Level 2", elevation: ft(12), sheet: "A-102" },
    ];

    for (const floor of floors) {
      const level = building.level(ctx, { name: floor.name, elevation: floor.elevation });

      // The outside: four walls, 8 in thick, closed back to the first corner.
      // Wall 1 runs along the south side, wall 3 along the north.
      const outside = building.walls(ctx, { level, points: [at(0, 0), at(40, 0), at(40, 30), at(0, 30)], closed: true, thickness: units.in(8), height: ft(11) });

      // Inside: one wall north to south at 24 ft, and one east of it at 15 ft.
      const split = building.walls(ctx, { level, points: [at(24, 0), at(24, 30)], thickness: units.in(5), height: ft(11) });
      const office = building.walls(ctx, { level, points: [at(24, 15), at(40, 15)], thickness: units.in(5), height: ft(11) });

      // Doors are placed along a wall, from its start. The entry is on the ground floor only.
      if (floor.name === "Level 1") building.door(ctx, { wall: outside.element(1), along: ft(10), width: units.in(36), mark: "101A" });
      building.door(ctx, { wall: split.element(1), along: ft(22), width: units.in(36) });
      building.door(ctx, { wall: office.element(1), along: ft(4), width: units.in(36) });

      // Windows on the north wall (it runs east to west, so 6 ft along it is near the east end).
      for (const along of [6, 18, 30]) building.window(ctx, { wall: outside.element(3), along: ft(along), width: ft(4), height: ft(5) });

      // Rooms from the walls: one point inside each, the kernel traces the enclosure.
      const n = floor.name === "Level 1" ? 100 : 200;
      const open = building.spaceInWalls(ctx, { level, inside: at(10, 15), number: `${n + 1}`, name: "Open office" });
      const conference = building.spaceInWalls(ctx, { level, inside: at(32, 7), number: `${n + 2}`, name: "Conference" });
      const privateOffice = building.spaceInWalls(ctx, { level, inside: at(32, 22), number: `${n + 3}`, name: "Office" });

      // A 9 ft ceiling in each room, its outline 1 ft inside the walls (units.* values, no millimetres by hand).
      const inset = (x0: number, y0: number, x1: number, y1: number) => [at(x0 + 1, y0 + 1), at(x1 - 1, y0 + 1), at(x1 - 1, y1 - 1), at(x0 + 1, y1 - 1)];
      building.ceiling(ctx, { level, space: open, outline: inset(0, 0, 24, 30), height: ft(9) });
      building.ceiling(ctx, { level, space: conference, outline: inset(24, 0, 40, 15), height: ft(9) });
      building.ceiling(ctx, { level, space: privateOffice, outline: inset(24, 15, 40, 30), height: ft(9) });
      made.push({ level: floor.name, id: level, rooms: [open, conference, privateOffice] });

      // A plan of this floor on its own sheet, 1/4" = 1'-0".
      const sheet = documents.sheet(ctx, { number: floor.sheet, name: `${floor.name} floor plan` });
      const plan = documents.planView(ctx, { level, name: `${floor.name} - Plan`, scale: 48 });
      documents.place(ctx, sheet, plan, { x: units.mm(300), y: units.mm(280) });
    }

    // What the script made, for the agent: it comes back as `report` beside the preview.
    ctx.report("Levels and rooms", made);
  },
});
