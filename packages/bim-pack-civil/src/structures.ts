import { partTypeDefinitionSchema, type PartTypeDefinition } from "@permitzip/bim-kernel";
import { CIVIL_STORM_SERVICE } from "./ids";

/**
 * The pack's storm structures as part types: point-placed, typed, with pipe
 * connectors of the `civil.storm` system, so storm pipes are routed onto
 * them with the kernel's own commands. Rim, invert and an inlet's capacity
 * are the pack's own parameters on the classed part (`parameters.ts`), not
 * type parameters. Checked by the kernel's part-type schema at load, so a bad
 * row fails here, loudly.
 *
 * Connector frame: x east, y north, z up, mm from the insertion point; all at
 * 300 mm so pipes between structures run level in the model (the fall check
 * reads the inverts, not the drawn height).
 */

/** A pipe connector sized for the pipe it takes (15 in. = 381 mm, 18 in. = 457.2 mm): a size change at a structure would be a transition fitting. */
const pipe = (id: string, label: string, x: number, y: number, flowDirection: "in" | "out", diameterIn: number) => ({ id, label, domain: "pipe", systemKind: CIVIL_STORM_SERVICE, position: [x, y, 300] as [number, number, number], direction: [Math.sign(x), Math.sign(y), 0] as [number, number, number], shape: "round" as const, diameter: diameterIn * 25.4, flowDirection });

const body = (radius: number) => ({
  geometry: [{ kind: "cylinder" as const, center: [0, 0, 0] as [number, number, number], radius, height: 2400, axis: "z" as const }],
  symbol: [{ kind: "circle" as const, center: [0, 0] as [number, number], radius }],
});

const source = { kind: "builtin" as const, libraryVersion: "civil-0.1.0" };

/** A curb or grate inlet: one 15 in. outlet, west in its own frame (rotate the part to aim it). */
export const STORM_INLET_TYPE: PartTypeDefinition = partTypeDefinitionSchema.parse({
  familyName: "Storm inlet",
  typeName: "Type C grate",
  category: "pipe_accessory",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  connectors: [pipe("out", "Outlet", -600, 0, "out", 15)],
  ...body(600),
  tagFields: [],
  source,
});

/** A 48 in. manhole: 15 in. inlets east and north, an 18 in. outlet west. */
export const MANHOLE_TYPE: PartTypeDefinition = partTypeDefinitionSchema.parse({
  familyName: "Storm manhole",
  typeName: "48 in.",
  category: "pipe_accessory",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  connectors: [pipe("in_e", "Inlet east", 600, 0, "in", 15), pipe("in_n", "Inlet north", 0, 600, "in", 15), pipe("out", "Outlet", -600, 0, "out", 18)],
  ...body(600),
  tagFields: [],
  source,
});

/** An outfall headwall: one 18 in. inlet, east. */
export const OUTFALL_TYPE: PartTypeDefinition = partTypeDefinitionSchema.parse({
  familyName: "Storm outfall",
  typeName: "Headwall",
  category: "pipe_accessory",
  typeParams: [],
  typeValues: {},
  instanceParams: [],
  connectors: [pipe("in", "Inlet", 600, 0, "in", 18)],
  ...body(900),
  tagFields: [],
  source,
});
