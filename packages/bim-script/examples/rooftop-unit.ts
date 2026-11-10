/**
 * Rooftop unit: a 10 ton unit on the roof, ducted down into two rooms.
 *
 * The script sizes the supply and return ducts with the duct sizing read
 * (the system's friction and velocity limits), builds the unit's part type
 * with connectors of that size, places it on the roof, and routes its
 * supply and return down into the rooms. Then it tags the ducts on a plan
 * and puts an equipment schedule on a sheet.
 *
 * Run it: paste it to an assistant connected to the MutinyBIM tool server
 * ("run this script"), or `npm run example -- rooftop-unit`.
 */
import { defineScript, units, routes, parts, building, equipment, documents } from "@permitzip/bim-script";

const ft = units.ft;
const at = (x: number, y: number) => ({ x: ft(x), y: ft(y) });

/** 10 tons at 400 CFM per ton. */
const SUPPLY_CFM = 4000;

export default defineScript({
  kind: "route",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    // The building: one floor, 60 ft x 30 ft, two rooms side by side, a 10 ft ceiling.
    const level = building.level(ctx, { name: "Level 1", elevation: ft(0) });
    building.walls(ctx, { level, points: [at(0, 0), at(60, 0), at(60, 30), at(0, 30)], closed: true, thickness: units.in(8), height: ft(14) });
    building.walls(ctx, { level, points: [at(30, 0), at(30, 30)], thickness: units.in(5), height: ft(14) });
    building.spaceInWalls(ctx, { level, inside: at(15, 15), number: "101", name: "Classroom" });
    building.spaceInWalls(ctx, { level, inside: at(45, 15), number: "102", name: "Classroom" });

    // Size the main ducts first: 12 in deep to fit above the ceiling. Sizes come back in mm.
    const advice = ctx.read<{ suggested: { size: { width: number; height: number }; velocityFpm: number } }>("mechanical.duct_size", { cfm: SUPPLY_CFM, shape: "rect", height_mm: 305, system_kind: "supply_air" });
    const { width, height } = advice.suggested.size;
    const duct = routes.rect(units.mm(width), units.mm(height));

    // The unit's part type: a box with supply and return openings on its underside, sized like the ducts.
    // A route or layout script saves a new type as an edit (save_part_types). It never calls
    // ctx.parts.define (only a part script does); to use a type the model or library already has,
    // list its id in reads.partTypes and place it with equipment.place.
    const rtu = parts.part("Rooftop unit", { type: "10 ton", category: "mechanical_equipment" });
    rtu.box({ length: units.in(120), width: units.in(60), height: units.in(48) });
    for (const [id, label, systemKind, x] of [["supply", "Supply", "supply_air", -30], ["return", "Return", "return_air", 30]] as const) {
      rtu.connector("bottom", { id, label, domain: "duct", systemKind, shape: "rect", width: units.mm(width), height: units.mm(height), offset: [units.in(x), units.in(0)] });
    }
    ctx.edit({ type: "save_part_types", label: "Rooftop unit, 10 ton", types: [{ typeId: "example.rtu.10t", definition: rtu.build() }] });

    // On the roof: its base 14 ft above the floor, over the middle wall.
    const unit = equipment.place(ctx, { level, type: "example.rtu.10t", at: at(30, 15), height: ft(14), mark: "RTU-1" });

    // Supply down into room 101, return down into room 102, both at 11 ft (above the 10 ft ceiling).
    routes.along(ctx, { level, domain: "duct", size: duct, system: { id: "sa-1", kind: "supply_air", name: "Supply air" }, height: ft(11), from: unit.connector("supply"), points: [at(15, 15), at(8, 15)] });
    routes.along(ctx, { level, domain: "duct", size: duct, system: { id: "ra-1", kind: "return_air", name: "Return air" }, height: ft(11), from: unit.connector("return"), points: [at(45, 15), at(52, 15)] });

    // A mechanical plan cut above the ducts, every duct tagged with its size.
    const plan = documents.planView(ctx, { level, name: "Level 1 - Mechanical", scale: 48, cutHeight: ft(12), discipline: "mechanical" });
    documents.autoTag(ctx, { view: plan, categories: ["duct", "equipment"] });

    // The plan and an equipment schedule on sheets.
    const planSheet = documents.sheet(ctx, { number: "M-101", name: "Level 1 mechanical plan" });
    documents.place(ctx, planSheet, plan, { x: units.mm(300), y: units.mm(280) });
    const schedule = documents.schedule(ctx, { name: "Mechanical equipment schedule", category: "mechanical_equipment", columns: ["mark", "type_name", "level"] });
    const scheduleSheet = documents.sheet(ctx, { number: "M-601", name: "Mechanical schedules" });
    documents.place(ctx, scheduleSheet, schedule, { x: units.mm(200), y: units.mm(400) });

    ctx.label(`RTU-1 (${SUPPLY_CFM} CFM) with ${Math.round(width / 25.4)}x${Math.round(height / 25.4)} supply and return ducts at ${Math.round(advice.suggested.velocityFpm)} fpm`);
  },
});
