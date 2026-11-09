import type { AuthorRef } from "@permitzip/bim-kernel";
import { contentHashOf, makeItem, scriptItemSchema, scriptManifestSchema, type ScriptItem, type ScriptManifestInput } from "@permitzip/bim-library";

/**
 * Starter scripts: five worked examples a firm library ships with, written
 * with the kit's `parts` and `routes` helpers. Each is an ordinary `script`
 * library item (source + manifest), so it runs, is approved and makes
 * provenance exactly like a script an agent writes. Their system kinds,
 * sizes and words live in the items, not in the kit. Part scripts keep their
 * own type ids and open parameters (a later fabrication mapping keys on them).
 */

export const STARTER_AUTHOR: AuthorRef = { provider: "mutinybim", subject: "starter-scripts", kind: "organization", displayName: "MutinyBIM starter scripts" };

const IN = 0.0254;
const FT = 0.3048;

interface Starter {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly manifest: ScriptManifestInput;
  /** The run body, after `const P = <parameters>;` and the kit import. */
  readonly body: string;
}

function source(s: Starter): string {
  const params = JSON.stringify(s.manifest.parameters, null, 2);
  const presets = JSON.stringify(s.manifest.presets ?? []);
  return [
    `import { defineScript, parts, routes, units } from "@permitzip/bim-script";`,
    ``,
    `// ${s.name}: ${s.description}`,
    `const P = ${params};`,
    ``,
    `export default defineScript({`,
    `  kind: ${JSON.stringify(s.manifest.kind)},`,
    `  reads: ${JSON.stringify(s.manifest.reads)},`,
    `  parameters: P,`,
    `  presets: ${presets},`,
    `  run(ctx, v) {`,
    ...s.body.trim().split("\n").map((l) => `    ${l}`),
    `  },`,
    `});`,
    ``,
  ].join("\n");
}

const STARTERS: readonly Starter[] = [
  {
    key: "starter.rectangular_plenum",
    name: "Rectangular plenum",
    description: "a box with a rectangular inlet on its back and a round outlet on top, sized by its parameters",
    manifest: {
      kind: "part",
      reads: {},
      parameters: {
        length: { type: "quantity", kind: "length", unit: "in", label: "Length", default: 24 * IN, min: 6 * IN, max: 120 * IN },
        width: { type: "quantity", kind: "length", unit: "in", label: "Width", default: 12 * IN, min: 6 * IN, max: 120 * IN },
        height: { type: "quantity", kind: "length", unit: "in", label: "Height", default: 12 * IN, min: 6 * IN, max: 60 * IN },
        outlet: { type: "quantity", kind: "length", unit: "in", label: "Outlet diameter", default: 10 * IN, min: 4 * IN, max: 48 * IN },
        end_type: { type: "choice", label: "How the openings join", choices: [{ value: "mechanical.slip", label: "Slip" }, { value: "mechanical.flanged", label: "Flanged" }, { value: "mechanical.formed_flange", label: "Formed flange (TDC / TDF)" }], default: "mechanical.slip" },
      },
      presets: [{ id: "p24x12", title: "24 x 12 with a 10 in outlet", values: { length: 24 * IN, width: 12 * IN, height: 12 * IN, outlet: 10 * IN } }],
    },
    body: `
const inch = (m) => Math.round(units.in_(m, "in"));
const size = inch(v.length) + "x" + inch(v.width) + "x" + inch(v.height);
const p = parts.part("Rectangular plenum", { type: size + " with " + inch(v.outlet) + " in outlet", category: "duct_accessory" });
const L = p.param("length", { label: "Length", value: v.length });
const W = p.param("width", { label: "Width", value: v.width });
const H = p.param("height", { label: "Height", value: v.height });
const D = p.param("outlet_diameter", { label: "Outlet diameter", value: v.outlet });
p.box({ length: L, width: W, height: H });
p.connector("back", { id: "inlet", label: "Inlet", domain: "duct", systemKind: "supply_air", shape: "rect", width: W, height: H, flowDirection: "in", endType: v.end_type });
p.connector("top", { id: "outlet", label: "Outlet", domain: "duct", systemKind: "supply_air", shape: "round", diameter: D, flowDirection: "out", endType: v.end_type });
ctx.parts.define("plenum_rect:" + size + ":" + inch(v.outlet), p.build());
`,
  },
  {
    key: "starter.round_tee",
    name: "Round tee",
    description: "a straight round body with a round branch off one side",
    manifest: {
      kind: "part",
      reads: {},
      parameters: {
        main: { type: "quantity", kind: "length", unit: "in", label: "Main diameter", default: 12 * IN, min: 3 * IN, max: 60 * IN },
        branch: { type: "quantity", kind: "length", unit: "in", label: "Branch diameter", default: 8 * IN, min: 3 * IN, max: 60 * IN },
        length: { type: "quantity", kind: "length", unit: "in", label: "Body length", default: 16 * IN, min: 4 * IN, max: 96 * IN },
        end_type: { type: "choice", label: "How the openings join", choices: [{ value: "mechanical.slip", label: "Slip" }, { value: "mechanical.flanged", label: "Flanged" }, { value: "mechanical.formed_flange", label: "Formed flange (TDC / TDF)" }], default: "mechanical.slip" },
      },
    },
    body: `
const inch = (m) => Math.round(units.in_(m, "in"));
if (units.in_(v.branch, "mm") > units.in_(v.main, "mm")) throw new Error("The branch is wider than the main; make the branch the same size or smaller.");
const p = parts.part("Round tee", { type: inch(v.main) + "x" + inch(v.main) + "x" + inch(v.branch), category: "duct_accessory" });
const D = p.param("main_diameter", { label: "Main diameter", value: v.main });
const B = p.param("branch_diameter", { label: "Branch diameter", value: v.branch });
const L = p.param("body_length", { label: "Body length", value: v.length });
p.cylinder({ diameter: D, length: L, axis: "x" });
p.connector("back", { id: "a", label: "Main in", domain: "duct", systemKind: "supply_air", shape: "round", diameter: D, flowDirection: "in", endType: v.end_type });
p.connector("front", { id: "b", label: "Main out", domain: "duct", systemKind: "supply_air", shape: "round", diameter: D, flowDirection: "out", endType: v.end_type });
p.connector("left", { id: "branch", label: "Branch", domain: "duct", systemKind: "supply_air", shape: "round", diameter: B, flowDirection: "out", endType: v.end_type });
ctx.parts.define("tee_round:" + inch(v.main) + ":" + inch(v.branch), p.build());
`,
  },
  {
    key: "starter.duct_run_along_corridor",
    name: "Duct run along a corridor",
    description: "a rectangular supply run from one end of a corridor to the other at a set height",
    manifest: {
      kind: "route",
      reads: { levels: true },
      parameters: {
        level: { type: "text", label: "Level id (blank: the lowest level)", default: "" },
        from_x: { type: "quantity", kind: "length", unit: "ft", label: "Start, east", default: 0 },
        from_y: { type: "quantity", kind: "length", unit: "ft", label: "Start, north", default: 0 },
        to_x: { type: "quantity", kind: "length", unit: "ft", label: "End, east", default: 40 * FT },
        to_y: { type: "quantity", kind: "length", unit: "ft", label: "End, north", default: 0 },
        height: { type: "quantity", kind: "length", unit: "ft", label: "Height above the floor", default: 9 * FT, min: 0, max: 40 * FT },
        width: { type: "quantity", kind: "length", unit: "in", label: "Duct width", default: 12 * IN, min: 4 * IN, max: 96 * IN },
        depth: { type: "quantity", kind: "length", unit: "in", label: "Duct depth", default: 8 * IN, min: 4 * IN, max: 96 * IN },
        system: { type: "text", label: "System id", default: "starter-supply" },
      },
    },
    body: `
const levels = ctx.model.levels();
const level = v.level ? ctx.model.get(v.level) : levels.slice().sort((a, b) => a.elevationMm - b.elevationMm)[0];
if (!level) throw new Error("The model has no level to route on.");
routes.along(ctx, {
  level: level.id,
  domain: "duct",
  size: routes.rect(v.width, v.depth),
  system: { id: v.system, kind: "supply_air", name: "Supply" },
  height: v.height,
  points: [{ x: v.from_x, y: v.from_y }, { x: v.to_x, y: v.to_y }],
});
ctx.label("Supply " + Math.round(units.in_(v.width, "in")) + "x" + Math.round(units.in_(v.depth, "in")) + " along the corridor at " + Math.round(units.in_(v.height, "ft") * 10) / 10 + " ft, " + level.name);
`,
  },
  {
    key: "starter.sprinkler_branch_line",
    name: "Sprinkler branch line",
    description: "a capped wet-system pipe line between two points at a set height",
    manifest: {
      kind: "route",
      reads: { levels: true },
      parameters: {
        level: { type: "text", label: "Level id (blank: the lowest level)", default: "" },
        from_x: { type: "quantity", kind: "length", unit: "ft", label: "Start, east", default: 0 },
        from_y: { type: "quantity", kind: "length", unit: "ft", label: "Start, north", default: 0 },
        to_x: { type: "quantity", kind: "length", unit: "ft", label: "End, east", default: 30 * FT },
        to_y: { type: "quantity", kind: "length", unit: "ft", label: "End, north", default: 0 },
        height: { type: "quantity", kind: "length", unit: "ft", label: "Height above the floor", default: 10 * FT, min: 0, max: 40 * FT },
        size: { type: "quantity", kind: "length", unit: "in", label: "Pipe size", default: 1 * IN, min: 0.75 * IN, max: 4 * IN },
        system: { type: "text", label: "System id", default: "starter-wet" },
      },
    },
    body: `
const levels = ctx.model.levels();
const level = v.level ? ctx.model.get(v.level) : levels.slice().sort((a, b) => a.elevationMm - b.elevationMm)[0];
if (!level) throw new Error("The model has no level to route on.");
routes.along(ctx, {
  level: level.id,
  domain: "pipe",
  size: routes.pipe(v.size, "black_steel"),
  system: { id: v.system, kind: "fire_protection_wet", name: "Wet sprinkler" },
  height: v.height,
  points: [{ x: v.from_x, y: v.from_y }, { x: v.to_x, y: v.to_y }],
  capEnd: true,
});
ctx.label("Sprinkler branch line, " + units.in_(v.size, "in") + " in, " + level.name);
`,
  },
  {
    key: "starter.bathroom_group_stub_out",
    name: "Bathroom group stub-out",
    description: "cold and hot water stub-outs out of a wall for a lavatory, a water closet and a shower",
    manifest: {
      kind: "route",
      reads: { levels: true },
      parameters: {
        level: { type: "text", label: "Level id (blank: the lowest level)", default: "" },
        wall_x: { type: "quantity", kind: "length", unit: "ft", label: "Wall start, east", default: 0 },
        wall_y: { type: "quantity", kind: "length", unit: "ft", label: "Wall face, north", default: 0 },
        spacing: { type: "quantity", kind: "length", unit: "ft", label: "Fixture spacing", default: 3 * FT, min: 2 * FT, max: 10 * FT },
        stub: { type: "quantity", kind: "length", unit: "in", label: "Stub length out of the wall", default: 12 * IN, min: 6 * IN, max: 36 * IN },
        height: { type: "quantity", kind: "length", unit: "in", label: "Stub height", default: 21 * IN, min: 6 * IN, max: 84 * IN },
        cold_system: { type: "text", label: "Cold water system id", default: "starter-cold" },
        hot_system: { type: "text", label: "Hot water system id", default: "starter-hot" },
      },
    },
    body: `
const levels = ctx.model.levels();
const level = v.level ? ctx.model.get(v.level) : levels.slice().sort((a, b) => a.elevationMm - b.elevationMm)[0];
if (!level) throw new Error("The model has no level to route on.");
const fixtures = [{ name: "Lavatory", hot: true }, { name: "Water closet", hot: false }, { name: "Shower", hot: true }];
const m = (mm) => ({ kind: "length", value: mm / 1000 });
const x0 = units.in_(v.wall_x, "mm");
const y0 = units.in_(v.wall_y, "mm");
const out = units.in_(v.stub, "mm");
const gap = units.in_(v.spacing, "mm");
const side = units.in_(units.in(4), "mm");
fixtures.forEach((f, i) => {
  const x = x0 + i * gap;
  const stub = (dx, system, kind, name) => routes.along(ctx, {
    level: level.id,
    domain: "pipe",
    size: routes.pipe(units.in(0.5), "copper"),
    system: { id: system, kind: kind, name: name },
    height: v.height,
    points: [{ x: m(x + dx), y: m(y0) }, { x: m(x + dx), y: m(y0 + out) }],
    capEnd: true,
  });
  stub(-side, v.cold_system, "domestic_cold_water", "Cold water");
  if (f.hot) stub(side, v.hot_system, "domestic_hot_water", "Hot water");
});
ctx.label("Stub-outs for a lavatory, a water closet and a shower, " + level.name);
`,
  },
  {
    key: "starter.rooftop_unit",
    name: "Rooftop unit",
    description: "a packaged rooftop unit that looks like one: curb, base rail, casing in return / blower / heat / condenser sections, access doors with handles, condenser louvres and fans, an outside-air hood, and its supply, return, outside-air, gas, power and condensate connections",
    manifest: {
      kind: "part",
      reads: {},
      parameters: {
        tons: { type: "number", label: "Cooling capacity (tons)", default: 10, min: 2, max: 50 },
        heat: { type: "choice", label: "Heat", choices: [{ value: "gas", label: "Gas heat" }, { value: "electric", label: "Electric heat" }, { value: "none", label: "Cooling only" }], default: "gas" },
        length: { type: "quantity", kind: "length", unit: "in", label: "Casing length", default: 110 * IN, min: 60 * IN, max: 300 * IN },
        width: { type: "quantity", kind: "length", unit: "in", label: "Casing width", default: 60 * IN, min: 36 * IN, max: 120 * IN },
        height: { type: "quantity", kind: "length", unit: "in", label: "Casing height", default: 44 * IN, min: 30 * IN, max: 100 * IN },
        curb: { type: "boolean", label: "Include the roof curb", default: true },
        curb_height: { type: "quantity", kind: "length", unit: "in", label: "Curb height", default: 14 * IN, min: 8 * IN, max: 36 * IN },
        supply_width: { type: "quantity", kind: "length", unit: "in", label: "Supply opening width", default: 24 * IN, min: 8 * IN, max: 96 * IN },
        supply_depth: { type: "quantity", kind: "length", unit: "in", label: "Supply opening depth", default: 16 * IN, min: 6 * IN, max: 60 * IN },
        return_width: { type: "quantity", kind: "length", unit: "in", label: "Return opening width", default: 30 * IN, min: 8 * IN, max: 96 * IN },
        return_depth: { type: "quantity", kind: "length", unit: "in", label: "Return opening depth", default: 18 * IN, min: 6 * IN, max: 60 * IN },
        airflow: { type: "number", label: "Supply airflow (CFM)", default: 4000, min: 300, max: 40000 },
        voltage: { type: "choice", label: "Voltage", choices: [{ value: "208", label: "208 V, 3 phase" }, { value: "460", label: "460 V, 3 phase" }, { value: "575", label: "575 V, 3 phase" }], default: "460" },
        weight: { type: "number", label: "Operating weight (lb)", default: 1250, min: 100, max: 20000 },
        service_clearance: { type: "quantity", kind: "length", unit: "in", label: "Service clearance, access side", default: 48 * IN, min: 0, max: 120 * IN },
      },
      presets: [{ id: "t10_gas", title: "10 ton, gas heat, 460 V", values: { tons: 10, heat: "gas", voltage: "460" } }],
    },
    body: `
const n = (m) => units.in_(m, "in");
const I = (x) => units.in(x);
const L = n(v.length), W = n(v.width), H = n(v.height);
const C = v.curb ? n(v.curb_height) : 0;
const RAIL = 4;
const bottom = C + RAIL;
const top = bottom + H;
const side = W / 2;
const heatName = v.heat === "gas" ? "gas heat" : v.heat === "electric" ? "electric heat" : "cooling only";
const p = parts.part("Rooftop unit", { type: v.tons + " ton, " + heatName + ", " + v.voltage + " V", category: "mechanical_equipment", description: "Packaged rooftop unit, " + v.tons + " tons, " + heatName });
// Data fields: schedules print them.
p.param("cooling_tons", { label: "Cooling capacity", value: v.tons, unit: "tons" });
p.param("supply_airflow", { label: "Supply airflow", value: v.airflow, unit: "cfm" });
p.param("operating_weight", { label: "Operating weight", value: v.weight, unit: "lb" });
p.param("voltage", { label: "Voltage", value: Number(v.voltage), unit: "v" });
p.param("heat", { label: "Heat", value: heatName });
p.param("curb_size", { label: "Curb size", value: Math.round(L - 4) + " x " + Math.round(W - 4) + " in" });
p.instanceParam("serves", { label: "Serves", kind: "text" });
// Curb: a hollow frame the unit sits on; the ducts drop through it.
if (C > 0) p.extrude(parts.rect(I(L - 4), I(W - 4)).hole(parts.rect(I(L - 8), I(W - 8))), { to: I(C), id: "curb", material: "Galvanized steel" });
p.extrude(parts.rect(I(L), I(W)), { from: I(C), to: I(bottom), id: "base_rail", material: "Galvanized steel" });
p.extrude(parts.rect(I(L - 1), I(W - 1), { fillet: I(0.75) }), { from: I(bottom), to: I(top), id: "casing", material: "Painted steel" });
// Sections along the length, back (return end) to front (condenser end).
const x0 = -L / 2;
const seams = [x0 + 0.22 * L, x0 + 0.44 * L, x0 + 0.62 * L];
const face = side - 0.5;
seams.forEach((x, i) => p.cut(parts.rect(I(0.5), I(H - 3), { center: [I(x), I(bottom + H / 2)] }), { on: "side", from: I(face - 0.3), to: I(face + 1), id: "seam" + (i + 1) }));
p.mirror(["seam1", "seam2", "seam3"], { across: "y" });
// Access doors: a shallow recess per section with two handles, on the access side (+y).
const doors = [[x0 + 0.11 * L, 0.18 * L], [x0 + 0.33 * L, 0.18 * L], [x0 + 0.53 * L, 0.14 * L]];
doors.forEach(([cx, w], i) => {
  p.cut(parts.rect(I(w), I(H - 8), { center: [I(cx), I(bottom + H / 2)], fillet: I(1) }), { on: "side", from: I(face - 0.15), to: I(face + 1), id: "door" + (i + 1) });
  p.extrude(parts.rect(I(1.25), I(4), { center: [I(cx + w / 2 - 3), I(bottom + H * 0.3)] }), { on: "side", from: I(face - 0.2), to: I(face + 1.25), id: "handle" + (i + 1), show: ["medium", "fine"] });
  p.pattern(["handle" + (i + 1)], { along: "z", count: 2, spacing: I(H * 0.4) });
});
// Condenser coil louvres on both long sides and the front end.
const condStart = x0 + 0.62 * L + 2;
const condLength = L / 2 - condStart - 2;
p.cut(parts.rect(I(condLength), I(0.75), { center: [I(condStart + condLength / 2), I(bottom + 4)] }), { on: "side", from: I(face - 0.4), to: I(face + 1), id: "louvre", show: ["fine"] });
p.pattern(["louvre"], { along: "z", count: Math.max(2, Math.floor((H - 8) / 2.5)), spacing: I(2.5) }, { id: "louvres" });
p.mirror(["louvre", "louvres"], { across: "y" });
p.cut(parts.rect(I(W - 8), I(0.75), { center: [I(0), I(bottom + 4)] }), { on: "front", from: I(L / 2 - 0.9), to: I(L / 2 + 1), id: "end_louvre", show: ["fine"] });
p.pattern(["end_louvre"], { along: "z", count: Math.max(2, Math.floor((H - 8) / 2.5)), spacing: I(2.5) });
// Condenser fans on top of the condenser section: a guard ring, a hub and blades; two side by side when the unit is wide enough.
const fans = W >= 56 ? 2 : 1;
const fanD = Math.min(26, condLength - 4, fans === 2 ? W / 2 - 4 : W * 0.6);
const fanX = condStart + condLength / 2;
const fanY = fans === 2 ? -W / 4 : 0;
p.extrude(parts.circle(I(fanD)).hole(parts.circle(I(fanD - 2))).at(I(fanX), I(fanY)), { from: I(top), to: I(top + 2), id: "fan_guard" });
p.extrude(parts.circle(I(6)).at(I(fanX), I(fanY)), { from: I(top), to: I(top + 3), id: "fan_hub", show: ["medium", "fine"] });
p.extrude(parts.rect(I(fanD / 2 - 4), I(3), { center: [I(fanX + fanD / 4 + 1), I(fanY)] }), { from: I(top + 0.5), to: I(top + 1.5), id: "fan_blade", show: ["fine"] });
p.pattern(["fan_blade"], { around: "z", count: 4, center: [I(fanX), I(fanY), I(0)] }, { id: "fan_blades" });
if (fans === 2) p.pattern(["fan_guard", "fan_hub", "fan_blade", "fan_blades"], { along: "y", count: 2, spacing: I(W / 2) });
// Outside-air hood on the return end: a sloped rain hood, open underneath.
const hoodW = W * 0.7;
p.extrude(parts.polygon([[I(x0 + 0.5), I(top - 3)], [I(x0 - 14), I(top - 12)], [I(x0 - 14), I(top - 26)], [I(x0 + 0.5), I(top - 26)]]), { on: "side", from: I(-hoodW / 2), to: I(hoodW / 2), id: "oa_hood" });
p.cut(parts.polygon([[I(x0), I(top - 5)], [I(x0 - 12.5), I(top - 13)], [I(x0 - 12.5), I(top - 27)], [I(x0), I(top - 27)]]), { on: "side", from: I(-hoodW / 2 + 1), to: I(hoodW / 2 - 1), id: "oa_opening" });
// Gas heat: a flue hood and a gas inlet stub on the service side.
const heatX = x0 + 0.53 * L;
if (v.heat === "gas") {
  p.extrude(parts.polygon([[I(heatX - 5), I(top - 6)], [I(heatX + 5), I(top - 6)], [I(heatX + 5), I(top - 16)], [I(heatX - 5), I(top - 12)]]), { on: "side", from: I(-side - 5), to: I(-side + 0.5), id: "flue_hood" });
  p.cylinder({ diameter: I(1.05), length: I(6), axis: "y" }, { x: I(heatX + 8), y: I(-side - 2.5), z: I(bottom + 8), id: "gas_stub" });
}
// Disconnect on the condenser end.
p.box({ length: I(8), width: I(5), height: I(12) }, { x: I(L / 2 - 14), y: I(-side - 2.5), base: I(bottom + 10), id: "disconnect" });
// Connections: ducts down through the curb, outside air into the hood, gas, power, condensate.
const retX = x0 + 0.11 * L;
const supX = x0 + 0.33 * L;
p.connectorAt({ id: "return", label: "Return air", domain: "duct", systemKind: "return_air", shape: "rect", width: v.return_width, height: v.return_depth, flowDirection: "in", flow: v.airflow, at: [I(retX), I(0), I(0)], facing: "bottom", endType: "mechanical.slip" });
p.connectorAt({ id: "supply", label: "Supply air", domain: "duct", systemKind: "supply_air", shape: "rect", width: v.supply_width, height: v.supply_depth, flowDirection: "out", flow: v.airflow, at: [I(supX), I(0), I(0)], facing: "bottom", endType: "mechanical.slip" });
p.connectorAt({ id: "outside_air", label: "Outside air", domain: "duct", systemKind: "outside_air", shape: "rect", width: I(hoodW - 2), height: I(12), flowDirection: "in", at: [I(x0 - 6), I(0), I(top - 26)], facing: "bottom", endType: "mechanical.slip" });
if (v.heat === "gas") p.connectorAt({ id: "gas", label: "Gas", domain: "pipe", systemKind: "natural_gas", shape: "round", diameter: I(0.75), flowDirection: "in", at: [I(heatX + 8), I(-side - 5.5), I(bottom + 8)], facing: "right", endType: "plumbing_gas.threaded" });
p.connectorAt({ id: "power", label: "Power", domain: "electrical", systemKind: "power", shape: "none", voltage: Number(v.voltage), poles: 3, at: [I(L / 2 - 14), I(-side - 5), I(bottom + 16)], facing: "right" });
p.connectorAt({ id: "condensate", label: "Condensate drain", domain: "pipe", systemKind: "condensate", shape: "round", diameter: I(0.75), flowDirection: "out", at: [I(x0 + 0.33 * L), I(-side), I(bottom + 2)], facing: "right", endType: "plumbing_gas.threaded" });
p.clearance({ id: "service", name: "Service", purpose: "service_access", face: "left", depth: v.service_clearance });
p.clearance({ id: "condenser", name: "Condenser air", purpose: "keep_out", face: "front", depth: I(48) });
// Coarse plans: the outline with an X and the curb; medium and fine draw the solid from above.
p.symbol("coarse", { shapes: [parts.rect(I(L), I(W))], lines: [[[I(-L / 2), I(-W / 2)], [I(L / 2), I(W / 2)]], [[I(-L / 2), I(W / 2)], [I(L / 2), I(-W / 2)]]] });
ctx.parts.define("rtu:" + v.tons + ":" + v.heat + ":" + v.voltage + ":" + Math.round(L) + "x" + Math.round(W), p.build());
`,
  },
  {
    key: "starter.water_heater",
    name: "Water heater",
    description: "a tank water heater, gas or electric: jacket with domed head, legs, drain valve, relief valve, draft hood and flue (gas) or junction box (electric), with cold, hot, relief, drain and gas or power connections",
    manifest: {
      kind: "part",
      reads: {},
      parameters: {
        fuel: { type: "choice", label: "Fuel", choices: [{ value: "gas", label: "Gas" }, { value: "electric", label: "Electric" }], default: "gas" },
        gallons: { type: "number", label: "Storage (gal)", default: 50, min: 10, max: 120 },
        diameter: { type: "quantity", kind: "length", unit: "in", label: "Jacket diameter", default: 22 * IN, min: 14 * IN, max: 36 * IN },
        height: { type: "quantity", kind: "length", unit: "in", label: "Jacket height", default: 60 * IN, min: 24 * IN, max: 84 * IN },
        input: { type: "number", label: "Input (MBH gas, kW electric)", default: 40, min: 1, max: 500 },
        connection: { type: "quantity", kind: "length", unit: "in", label: "Water connection size", default: 0.75 * IN, min: 0.5 * IN, max: 2 * IN },
        flue: { type: "quantity", kind: "length", unit: "in", label: "Flue diameter (gas)", default: 4 * IN, min: 3 * IN, max: 8 * IN },
      },
    },
    body: `
const n = (m) => units.in_(m, "in");
const I = (x) => units.in(x);
const D = n(v.diameter), H = n(v.height), R = D / 2;
const gas = v.fuel === "gas";
const LEG = 1.5;
const p = parts.part("Water heater", { type: v.gallons + " gal " + (gas ? "gas" : "electric"), category: "plumbing_fixture", description: v.gallons + " gallon " + v.fuel + " tank water heater" });
p.param("storage_gallons", { label: "Storage", value: v.gallons, unit: "count" });
p.param(gas ? "input_btuh" : "input_kw", gas ? { label: "Input", value: v.input * 1000, unit: "btuh" } : { label: "Input", value: v.input, unit: "kw" });
p.param("fuel", { label: "Fuel", value: v.fuel });
// The jacket: a revolved outline with a rounded shoulder and a domed head.
const dome = [];
for (let i = 0; i <= 6; i++) {
  const a = (i / 6) * Math.PI / 2;
  dome.push([I((R - 1) * Math.cos(a)), I(H - 3 + 3 * Math.sin(a))]);
}
p.revolve(parts.polygon([[I(0), I(LEG)], [I(R), I(LEG)], [I(R), I(H - 3)], ...dome.slice(1).map(([u, w]) => [u, w]), [I(0), I(H)]]), { on: "front", axis: [[I(0), I(0)], [I(0), I(1)]], id: "jacket" });
// Three legs.
p.extrude(parts.rect(I(2), I(2), { center: [I(R - 3), I(0)] }), { to: I(LEG + 0.5), id: "leg" });
p.pattern(["leg"], { around: "z", count: 3 });
// Drain valve low on the front, relief valve high on the side.
p.cylinder({ diameter: I(1), length: I(3), axis: "x" }, { x: I(R + 1), z: I(LEG + 5), id: "drain_valve" });
p.cylinder({ diameter: I(1.25), length: I(4), axis: "y" }, { y: I(R + 1.5), z: I(H - 8), id: "relief_valve" });
// Water connections through the head.
p.cylinder({ diameter: v.connection, length: I(3), axis: "z" }, { x: I(-R * 0.45), z: I(H + 1.5), id: "cold_nipple" });
p.mirror(["cold_nipple"], { across: "x" });
if (gas) {
  // Draft hood and flue.
  p.revolve(parts.polygon([[I(n(v.flue) / 2), I(H + 4)], [I(n(v.flue) / 2 + 3), I(H + 1)], [I(n(v.flue) / 2 + 3), I(H + 2)], [I(n(v.flue) / 2 + 0.2), I(H + 5)]]), { on: "front", axis: [[I(0), I(0)], [I(0), I(1)]], id: "draft_hood" });
  p.cylinder({ diameter: v.flue, length: I(4), axis: "z" }, { z: I(H + 6), id: "flue" });
  p.box({ length: I(5), width: I(4), height: I(6) }, { x: I(R + 1.5), base: I(LEG + 8), id: "gas_valve" });
} else {
  p.box({ length: I(4), width: I(4), height: I(3) }, { x: I(R * 0.3), y: I(R * 0.3), base: I(H), id: "junction_box" });
}
p.connectorAt({ id: "cold", label: "Cold water in", domain: "pipe", systemKind: "domestic_cold_water", shape: "round", diameter: v.connection, flowDirection: "in", at: [I(-R * 0.45), I(0), I(H + 3)], facing: "top", endType: "plumbing_gas.sweat" });
p.connectorAt({ id: "hot", label: "Hot water out", domain: "pipe", systemKind: "domestic_hot_water", shape: "round", diameter: v.connection, flowDirection: "out", at: [I(R * 0.45), I(0), I(H + 3)], facing: "top", endType: "plumbing_gas.sweat" });
p.connectorAt({ id: "relief", label: "T&P relief", domain: "pipe", systemKind: "indirect_waste", shape: "round", diameter: I(0.75), flowDirection: "out", at: [I(0), I(R + 3.5), I(H - 8)], facing: "left", endType: "plumbing_gas.threaded" });
p.connectorAt({ id: "drain", label: "Drain valve", domain: "pipe", systemKind: "indirect_waste", shape: "round", diameter: I(0.75), flowDirection: "out", at: [I(R + 2.5), I(0), I(LEG + 5)], facing: "front", endType: "plumbing_gas.threaded" });
if (gas) {
  p.connectorAt({ id: "gas", label: "Gas", domain: "pipe", systemKind: "natural_gas", shape: "round", diameter: I(0.5), flowDirection: "in", at: [I(R + 4), I(0), I(LEG + 11)], facing: "front", endType: "plumbing_gas.threaded" });
  p.connectorAt({ id: "flue", label: "Flue", domain: "duct", systemKind: "exhaust_air", shape: "round", diameter: v.flue, flowDirection: "out", at: [I(0), I(0), I(H + 8)], facing: "top", endType: "mechanical.slip" });
} else {
  p.connectorAt({ id: "power", label: "Power", domain: "electrical", systemKind: "power", shape: "none", voltage: 240, poles: 2, at: [I(R * 0.3), I(R * 0.3), I(H + 3)], facing: "top" });
}
p.clearance({ id: "service", name: "Service", purpose: "service_access", face: "front", depth: I(24) });
p.symbol(["coarse", "medium"], { shapes: [parts.circle(v.diameter)], lines: [[[I(-R * 0.7), I(0)], [I(R * 0.7), I(0)]]] });
ctx.parts.define("water_heater:" + v.fuel + ":" + v.gallons, p.build());
`,
  },
  {
    key: "starter.electrical_panel",
    name: "Electrical panel",
    description: "a panelboard: tub, trim, door with hinges and latch, a feeder connection and branch-circuit raceway connections top and bottom, with the panel's voltage, phases, circuits and bus rating",
    manifest: {
      kind: "part",
      reads: {},
      parameters: {
        amps: { type: "number", label: "Bus rating (A)", default: 225, min: 60, max: 1200 },
        voltage: { type: "choice", label: "Voltage", choices: [{ value: "208", label: "208Y/120 V" }, { value: "480", label: "480Y/277 V" }, { value: "240", label: "120/240 V, 1 phase" }], default: "208" },
        circuits: { type: "number", label: "Circuits", integer: true, default: 42, min: 12, max: 84 },
        mains: { type: "choice", label: "Mains", choices: [{ value: "MLO", label: "Main lugs only" }, { value: "MCB", label: "Main breaker" }], default: "MLO" },
        feeder: { type: "choice", label: "Feeder enters", choices: [{ value: "top", label: "Top" }, { value: "bottom", label: "Bottom" }], default: "top" },
        width: { type: "quantity", kind: "length", unit: "in", label: "Width", default: 20 * IN, min: 14 * IN, max: 44 * IN },
        depth: { type: "quantity", kind: "length", unit: "in", label: "Depth", default: 5.75 * IN, min: 3.5 * IN, max: 12 * IN },
        mount_top: { type: "quantity", kind: "length", unit: "in", label: "Top of cabinet above floor", default: 78 * IN, min: 36 * IN, max: 120 * IN },
      },
    },
    body: `
const n = (m) => units.in_(m, "in");
const I = (x) => units.in(x);
const W = n(v.width), Dp = n(v.depth);
const circuits = Math.round(v.circuits);
const H = Math.max(24, 12 + Math.ceil(circuits / 2) * 1.0 + (v.mains === "MCB" ? 10 : 0));
const top = n(v.mount_top);
const base = top - H;
const phases = v.voltage === "240" ? 1 : 3;
const volts = v.voltage === "240" ? 240 : Number(v.voltage);
const p = parts.part("Panelboard", { type: v.amps + "A " + (v.voltage === "240" ? "120/240V" : v.voltage === "208" ? "208Y/120V" : "480Y/277V") + " " + circuits + " circuit " + v.mains, category: "electrical_equipment", tagFields: ["panel_name"] });
p.param("voltage", { label: "Voltage", value: volts, unit: "v" });
p.param("phases", { label: "Phases", value: String(phases) });
p.param("circuits", { label: "Circuits", value: circuits, unit: "count" });
p.param("bus_rating", { label: "Bus rating", value: v.amps, unit: "a" });
p.param("mains", { label: "Mains", value: v.mains });
p.instanceParam("panel_name", { label: "Panel name", kind: "text" });
p.instanceParam("aic", { label: "Short-circuit rating", kind: "number", unit: "a", default: 22000 });
p.instanceParam("enclosure", { label: "Enclosure", kind: "choice", choices: ["NEMA 1", "NEMA 3R", "NEMA 4X"], default: "NEMA 1" });
// The tub against the wall (+y is the wall; the door faces -y), the trim proud of it, the door recessed in the trim.
p.box({ length: I(W), width: I(Dp), height: I(H) }, { y: I(Dp / 2), base: I(base), id: "tub" });
p.extrude(parts.rect(I(W + 1.5), I(H + 1.5), { fillet: I(0.25), center: [I(0), I(base + H / 2)] }), { on: "side", from: I(-0.75), to: I(0), id: "trim" });
p.cut(parts.rect(I(W - 2), I(H - 2), { center: [I(0), I(base + H / 2)] }), { on: "side", from: I(-0.9), to: I(-0.6), id: "door_seam" });
// Hinges down the left edge and a latch on the right.
p.extrude(parts.rect(I(0.6), I(3), { center: [I(-W / 2 + 1.2), I(base + 3)] }), { on: "side", from: I(-1.1), to: I(-0.75), id: "hinge", show: ["fine"] });
p.pattern(["hinge"], { along: "z", count: 3, spacing: I((H - 6) / 2) });
p.extrude(parts.rect(I(1), I(2.5), { center: [I(W / 2 - 2), I(base + H / 2)], fillet: I(0.3) }), { on: "side", from: I(-1.4), to: I(-0.75), id: "latch", show: ["medium", "fine"] });
// Feeder and branch-circuit raceways: one connection each, top or bottom; circuits are the Electrical add-on's.
const feederZ = v.feeder === "top" ? top : base;
const feederFace = v.feeder === "top" ? "top" : "bottom";
const branchFace = v.feeder === "top" ? "bottom" : "top";
const branchZ = v.feeder === "top" ? base : top;
p.connectorAt({ id: "feeder", label: "Feeder", domain: "electrical", systemKind: "power", shape: "none", voltage: volts, poles: phases === 1 ? 2 : 3, flowDirection: "in", at: [I(0), I(Dp / 2), I(feederZ)], facing: feederFace });
p.connectorAt({ id: "branch_a", label: "Branch circuits, left", domain: "electrical", systemKind: "power", shape: "none", voltage: volts, poles: 1, flowDirection: "out", at: [I(-W / 4), I(Dp / 2), I(top)], facing: "top" });
p.connectorAt({ id: "branch_b", label: "Branch circuits, right", domain: "electrical", systemKind: "power", shape: "none", voltage: volts, poles: 1, flowDirection: "out", at: [I(W / 4), I(Dp / 2), I(top)], facing: "top" });
p.connectorAt({ id: "branch_c", label: "Branch circuits, below", domain: "electrical", systemKind: "power", shape: "none", voltage: volts, poles: 1, flowDirection: "out", at: [I(0), I(Dp / 2), I(branchZ)], facing: branchFace });
p.clearance({ id: "working_space", name: "Working space", purpose: "working_space", face: "right", depth: I(36), width: I(Math.max(30, W)), height: I(78), fromFloor: true });
p.symbol(["coarse", "medium", "fine"], { shapes: [parts.rect(I(W), I(Dp), { center: [I(0), I(Dp / 2)] })], lines: [[[I(-W / 2), I(0)], [I(W / 2), I(Dp)]]] });
ctx.parts.define("panel:" + v.amps + ":" + v.voltage + ":" + circuits + ":" + v.mains, p.build());
`,
  },
];

/** The starter scripts as library items (content-hashed), ready to serve as a read-only library. */
export function starterScriptItems(): ScriptItem[] {
  return STARTERS.map((s) => {
    const body = scriptItemSchema.parse({
      id: s.key,
      revision: 1,
      key: s.key,
      name: s.name,
      description: `${s.name}: ${s.description}.`,
      version: "1.0.0",
      language: "typescript",
      kit: ">=0.1.0",
      manifest: scriptManifestSchema.parse(s.manifest),
      source: source(s),
      license: "Apache-2.0",
      authors: [STARTER_AUTHOR],
    });
    return { ...body, contentHash: contentHashOf(makeItem("script", body)) };
  });
}
