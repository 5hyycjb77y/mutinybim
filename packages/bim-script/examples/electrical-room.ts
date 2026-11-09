/**
 * Electrical room: a one-bedroom unit's receptacles, circuits and panel
 * schedule.
 *
 * The script draws the unit's walls and rooms, places a panel, lets the
 * Electrical add-on propose receptacles by the code's wall spacing (NEC
 * 210.52: no point along a wall more than 6 ft from a receptacle), places
 * them, circuits them with a room template (one circuit per room), and puts
 * the panel's schedule on a sheet. The schedule prints the panel's loads
 * with the code's demand factors.
 *
 * Run it: paste it to an assistant connected to the MutinyBIM tool server
 * ("run this script"), or `npm run example -- electrical-room`.
 */
import { defineScript, units, building, equipment, documents } from "@permitzip/bim-script";

const ft = units.ft;
const at = (x: number, y: number) => ({ x: ft(x), y: ft(y) });
const box = (x0: number, x1: number) => [at(x0, 0), at(x1, 0), at(x1, 14), at(x0, 14)];
const NEC = "2023";

export default defineScript({
  kind: "layout",
  reads: { levels: true },
  parameters: {},
  run(ctx) {
    const level = building.level(ctx, { name: "Level 1", elevation: ft(0) });

    // A 32 ft x 14 ft unit: a bedroom and a living room, split by a wall at 14 ft.
    building.walls(ctx, { level, points: box(0, 32), closed: true, thickness: units.in(6), height: ft(9) });
    building.walls(ctx, { level, points: [at(14, 0), at(14, 14)], thickness: units.in(4), height: ft(9) });
    const bedroom = building.room(ctx, { level, number: "101", name: "Bedroom", outline: box(0, 14) });
    const living = building.room(ctx, { level, number: "102", name: "Living room", outline: box(14, 32) });

    // The unit's panel, on the bedroom wall.
    const panel = equipment.place(ctx, { level, type: "builtin:panelboard-125-208-1ph@1", at: at(1, 13), mark: "LP-1" });

    // Receptacles by code spacing: the add-on proposes them, with the clause for each; the script keeps them all.
    const proposal = ctx.propose("electrical.receptacles", { typeId: "builtin:duplex-receptacle@1", roomIds: [bedroom, living], options: { mode: "dwelling", edition: NEC } });
    ctx.acceptGhosts(proposal.ghosts, proposal.summary);

    // One circuit per room, from a room template the script saves into the model.
    ctx.edit({ type: "save_catalog_entry", entry: { type: "circuit_template", name: "One-bedroom unit", description: "Each room's receptacles on their own circuit", rules: [{ room: "bedroom", devices: "receptacles" }, { room: "living", devices: "receptacles" }] } });
    const circuits = ctx.read<{ command: unknown; message: string }>("electrical.circuit_template_plan", { template: "One-bedroom unit", units: [{ panel: "LP-1", rooms: ["101", "102"] }] });
    ctx.editSteps(circuits.command);

    // The panel's loads with the code's demand factors, and its schedule on a sheet printed by the same rules.
    const loads = ctx.read<{ connectedVa: number; demand: { demandVa: number }; rules: { id: string } }>("electrical.loads", { panel: "LP-1", nec_edition: NEC });
    const schedule = documents.formSchedule(ctx, { kind: "panel", name: "Panel LP-1 schedule", element: panel.id, rules: loads.rules.id });
    const sheet = documents.sheet(ctx, { number: "E-601", name: "Panel schedules" });
    documents.place(ctx, sheet, schedule, { x: units.mm(250), y: units.mm(350) });

    // A power plan of the unit on its own sheet.
    const plan = documents.planView(ctx, { level, name: "Level 1 - Power", scale: 48, discipline: "electrical" });
    const planSheet = documents.sheet(ctx, { number: "E-101", name: "Level 1 power plan" });
    documents.place(ctx, planSheet, plan, { x: units.mm(300), y: units.mm(280) });

    ctx.label(`${proposal.ghosts.length} receptacles (${proposal.passes ? "meets" : "short of"} NEC 210.52), ${circuits.message.toLowerCase()} LP-1 ${Math.round(loads.connectedVa)} VA connected`);
  },
});
