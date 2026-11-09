import { partDefinition, type PartTypeDefinition } from "../parts";
import type { Sketch } from "./schema";

/**
 * Worked examples for the part editor and for agents: generic, made up, no
 * manufacturer data. Lengths are millimetres.
 */

const IN = 25.4;

/** A rectangle whose corners sit on four reference planes (fully defined, flexes with them). */
export function rectangleOnPlanes(id: string, name: string, plane: string, planes: { readonly minU: string; readonly maxU: string; readonly minV: string; readonly maxV: string }, drawn: { readonly u0: number; readonly v0: number; readonly u1: number; readonly v1: number }): Sketch {
  const p = (k: string) => `${id}_${k}`;
  return {
    id,
    name,
    plane,
    points: [
      { id: p("a"), u: drawn.u0, v: drawn.v0 },
      { id: p("b"), u: drawn.u1, v: drawn.v0 },
      { id: p("c"), u: drawn.u1, v: drawn.v1 },
      { id: p("d"), u: drawn.u0, v: drawn.v1 },
    ],
    entities: [{ kind: "rectangle", id: `${id}_rect`, corners: [p("a"), p("b"), p("c"), p("d")] }],
    constraints: [
      { kind: "on_plane", point: p("a"), plane: planes.minU },
      { kind: "on_plane", point: p("a"), plane: planes.minV },
      { kind: "on_plane", point: p("c"), plane: planes.maxU },
      { kind: "on_plane", point: p("c"), plane: planes.maxV },
    ],
  };
}

/**
 * Packaged rooftop unit on a curb: a box body, a hollow curb under it, a
 * recessed service panel cut into the front, supply and return duct
 * connections through the bottom and a three-phase power connection.
 */
export function exampleRooftopUnit(): PartTypeDefinition {
  const curbOuter = { minU: "back", maxU: "front", minV: "right", maxV: "left" } as const;
  const curb: Sketch = {
    ...rectangleOnPlanes("curb", "Curb", "base", curbOuter, { u0: -1000, v0: -600, u1: 1000, v1: 600 }),
  };
  const inner = rectangleOnPlanes("curb_in", "Curb opening", "base", { minU: "curb_back", maxU: "curb_front", minV: "curb_right", maxV: "curb_left" }, { u0: -900, v0: -500, u1: 900, v1: 500 });
  const curbSketch: Sketch = { ...curb, points: [...curb.points, ...inner.points], entities: [...curb.entities, ...inner.entities], constraints: [...curb.constraints, ...inner.constraints] };
  return partDefinition("Rooftop unit on curb", {
    typeName: "RTU-10",
    category: "mechanical_equipment",
    description: "Packaged rooftop unit on a curb, bottom supply and return",
    typeParams: [
      { name: "length", label: "Length", kind: "length", unit: "mm", min: 300 },
      { name: "width", label: "Width", kind: "length", unit: "mm", min: 300 },
      { name: "height", label: "Height", kind: "length", unit: "mm", min: 200 },
      { name: "curb_height", label: "Curb height", kind: "length", unit: "mm", min: 0 },
      { name: "curb_wall", label: "Curb wall", kind: "length", unit: "mm", min: 25 },
      { name: "duct_width", label: "Duct opening width", kind: "length", unit: "mm", min: 100 },
      { name: "duct_depth", label: "Duct opening depth", kind: "length", unit: "mm", min: 100 },
      { name: "airflow", label: "Airflow", kind: "number", unit: "cfm", min: 0 },
      { name: "cooling", label: "Cooling", kind: "number", unit: "tons", min: 0 },
      { name: "voltage", label: "Voltage", kind: "number", unit: "v", min: 0 },
      { name: "phase", label: "Phase", kind: "number", unit: "count", min: 1, max: 3 },
      { name: "weight", label: "Operating weight", kind: "number", unit: "lb", min: 0 },
      { name: "manufacturer", label: "Manufacturer", kind: "text" },
      { name: "model", label: "Model", kind: "text" },
      { name: "duct_offset", label: "Duct offset from centre", kind: "length", unit: "mm", formula: "length / 4" },
    ],
    typeValues: {
      length: 90 * IN,
      width: 50 * IN,
      height: 40 * IN,
      curb_height: 14 * IN,
      curb_wall: 2 * IN,
      duct_width: 24 * IN,
      duct_depth: 14 * IN,
      airflow: 4000,
      cooling: 10,
      voltage: 208,
      phase: 3,
      weight: 1350,
      manufacturer: "Generic",
      model: "RTU-10",
    },
    instanceParams: [{ name: "room", label: "Serves", kind: "text" }],
    connectors: [
      {
        id: "supply",
        label: "Supply air",
        domain: "duct",
        systemKind: "supply_air",
        position: [{ param: "duct_offset" }, 0, { param: "curb_height" }],
        direction: [0, 0, -1],
        shape: "rect",
        width: { param: "duct_width" },
        height: { param: "duct_depth" },
        flow: { param: "airflow" },
        flowDirection: "out",
        widthAxis: [0, 1, 0],
      },
      {
        id: "return",
        label: "Return air",
        domain: "duct",
        systemKind: "return_air",
        position: [{ param: "duct_offset", scale: -1 }, 0, { param: "curb_height" }],
        direction: [0, 0, -1],
        shape: "rect",
        width: { param: "duct_width" },
        height: { param: "duct_depth" },
        flow: { param: "airflow" },
        flowDirection: "in",
        widthAxis: [0, 1, 0],
      },
      {
        id: "power",
        label: "Power",
        domain: "electrical",
        systemKind: "power",
        position: [{ param: "length", scale: -0.5 }, 0, { formula: "curb_height + height / 2" }],
        direction: [-1, 0, 0],
        shape: "none",
        voltage: { param: "voltage" },
        poles: 3,
        flowDirection: "in",
      },
    ],
    geometry: [],
    symbol: [{ kind: "text", at: [0, 0], text: "RTU", heightMm: 150 }],
    tagFields: ["mark", "cooling"],
    source: { kind: "builtin", libraryVersion: "part-editor-example-1" },
    model: {
      id: "rtu",
      planDisplay: "both",
      referencePlanes: [
        { id: "front", name: "Front", axis: "x", offset: { param: "length", scale: 0.5 } },
        { id: "back", name: "Back", axis: "x", offset: { param: "length", scale: -0.5 } },
        { id: "left", name: "Left", axis: "y", offset: { param: "width", scale: 0.5 } },
        { id: "right", name: "Right", axis: "y", offset: { param: "width", scale: -0.5 } },
        { id: "curb_front", name: "Curb inside front", axis: "x", offset: { formula: "length / 2 - curb_wall" } },
        { id: "curb_back", name: "Curb inside back", axis: "x", offset: { formula: "-length / 2 + curb_wall" } },
        { id: "curb_left", name: "Curb inside left", axis: "y", offset: { formula: "width / 2 - curb_wall" } },
        { id: "curb_right", name: "Curb inside right", axis: "y", offset: { formula: "-width / 2 + curb_wall" } },
        { id: "panel_low", name: "Panel bottom", axis: "z", offset: { formula: "curb_height + height * 0.3" } },
        { id: "panel_high", name: "Panel top", axis: "z", offset: { formula: "curb_height + height * 0.7" } },
        { id: "panel_left", name: "Panel left", axis: "y", offset: { param: "width", scale: 0.25 } },
        { id: "panel_right", name: "Panel right", axis: "y", offset: { param: "width", scale: -0.25 } },
      ],
      sketches: [
        rectangleOnPlanes("footprint", "Footprint", "base", curbOuter, { u0: -1100, v0: -600, u1: 1100, v1: 600 }),
        curbSketch,
        rectangleOnPlanes("panel", "Service panel", "front", { minU: "panel_right", maxU: "panel_left", minV: "panel_low", maxV: "panel_high" }, { u0: -300, v0: 500, u1: 300, v1: 1000 }),
      ],
      features: [
        { kind: "extrude", id: "body", name: "Cabinet", operation: "join", sketch: "footprint", start: { param: "curb_height" }, end: { formula: "curb_height + height" }, material: "Galvanized steel" },
        { kind: "extrude", id: "curb_ring", name: "Curb", operation: "join", sketch: "curb", start: 0, end: { param: "curb_height" } },
        { kind: "extrude", id: "panel_recess", name: "Service panel recess", operation: "cut", sketch: "panel", start: -25, end: 5, visibility: ["medium", "fine"] },
      ],
      types: [
        { name: "RTU-5", values: { length: 74 * IN, width: 44 * IN, height: 34 * IN, duct_width: 18 * IN, duct_depth: 12 * IN, airflow: 2000, cooling: 5, weight: 720, model: "RTU-5" } },
        { name: "RTU-10", values: { length: 90 * IN, width: 50 * IN, height: 40 * IN, duct_width: 24 * IN, duct_depth: 14 * IN, airflow: 4000, cooling: 10, weight: 1350, model: "RTU-10" } },
        { name: "RTU-15", values: { length: 110 * IN, width: 60 * IN, height: 48 * IN, duct_width: 30 * IN, duct_depth: 16 * IN, airflow: 6000, cooling: 15, weight: 1900, model: "RTU-15" } },
      ],
    },
  });
}

/** A floor drain: round body revolved about its vertical axis, an outlet stub, a strainer symbol. */
export function exampleFloorDrain(): PartTypeDefinition {
  return partDefinition("Floor drain", {
    typeName: '3" outlet',
    category: "plumbing_fixture",
    description: "Floor drain with round strainer and bottom outlet",
    typeParams: [
      { name: "strainer_diameter", label: "Strainer diameter", kind: "length", unit: "mm", min: 100 },
      { name: "body_depth", label: "Body depth", kind: "length", unit: "mm", min: 50 },
      { name: "outlet_diameter", label: "Outlet size", kind: "length", unit: "mm", min: 38 },
      { name: "outlet_length", label: "Outlet length", kind: "length", unit: "mm", min: 25 },
    ],
    typeValues: { strainer_diameter: 7 * IN, body_depth: 4 * IN, outlet_diameter: 3 * IN, outlet_length: 3 * IN },
    instanceParams: [],
    connectors: [
      {
        id: "outlet",
        label: "Outlet",
        domain: "pipe",
        systemKind: "sanitary",
        position: [0, 0, { formula: "-(body_depth + outlet_length)" }],
        direction: [0, 0, -1],
        shape: "round",
        diameter: { param: "outlet_diameter" },
        flowDirection: "out",
      },
    ],
    geometry: [],
    symbol: [
      { kind: "circle", center: [0, 0], radius: { param: "strainer_diameter", scale: 0.5 } },
      { kind: "line", from: [{ param: "strainer_diameter", scale: -0.35 }, 0], to: [{ param: "strainer_diameter", scale: 0.35 }, 0] },
      { kind: "line", from: [0, { param: "strainer_diameter", scale: -0.35 }], to: [0, { param: "strainer_diameter", scale: 0.35 }] },
    ],
    tagFields: ["mark"],
    source: { kind: "builtin", libraryVersion: "part-editor-example-1" },
    model: {
      id: "floor_drain",
      planDisplay: "symbol",
      referencePlanes: [{ id: "body_bottom", name: "Body bottom", axis: "z", offset: { param: "body_depth", scale: -1 } }],
      sketches: [
        {
          id: "body_profile",
          name: "Body profile",
          plane: "center_fb",
          points: [
            { id: "ax0", u: 0, v: 10 },
            { id: "ax1", u: 0, v: -150 },
            { id: "o0", u: 0, v: 0 },
            { id: "o1", u: 90, v: 0 },
            { id: "o2", u: 70, v: -100 },
            { id: "o3", u: 0, v: -100 },
          ],
          entities: [
            { kind: "line", id: "axis", a: "ax0", b: "ax1", construction: true },
            { kind: "polyline", id: "profile", points: ["o0", "o1", "o2", "o3"], closed: true },
          ],
          constraints: [
            { kind: "on_plane", point: "o0", plane: "center_lr" },
            { kind: "on_plane", point: "o0", plane: "base" },
            { kind: "on_plane", point: "o1", plane: "base" },
            { kind: "fix", point: "o1", u: { param: "strainer_diameter", scale: 0.5 } },
            { kind: "on_plane", point: "o2", plane: "body_bottom" },
            { kind: "fix", point: "o2", u: { param: "strainer_diameter", scale: 0.4 } },
            { kind: "on_plane", point: "o3", plane: "center_lr" },
            { kind: "on_plane", point: "o3", plane: "body_bottom" },
            { kind: "fix", point: "ax0", u: 0, v: 10 },
            { kind: "fix", point: "ax1", u: 0, v: -150 },
          ],
        },
        {
          id: "outlet_profile",
          name: "Outlet",
          plane: "body_bottom",
          points: [{ id: "c", u: 0, v: 0 }],
          entities: [{ kind: "circle", id: "outlet_circle", center: "c", radius: { param: "outlet_diameter", scale: 0.5 } }],
          constraints: [{ kind: "fix", point: "c", u: 0, v: 0 }],
        },
      ],
      features: [
        { kind: "revolve", id: "body", name: "Body", operation: "join", sketch: "body_profile", axis: "axis", startAngle: 0, endAngle: 360 },
        { kind: "extrude", id: "outlet", name: "Outlet", operation: "join", sketch: "outlet_profile", start: { param: "outlet_length", scale: -1 }, end: 1 },
      ],
      types: [],
    },
  });
}
