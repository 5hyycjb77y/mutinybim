import type { StarterElementTypeRow } from "@permitzip/bim-pack/runtime";

/**
 * Starter wall, door and window types, so a new model's Properties name a
 * type instead of "No type". The Wall, Door and Window tools start with the
 * `toolDefault` ones; the model takes a type the first time something is
 * drawn with it. Sizes are what US construction calls them (actual, not
 * nominal, where they differ), in mm.
 */

const IN = 25.4;
const mm = (inches: number): number => Math.round(inches * IN);

export const ARCHITECTURE_STARTER_TYPES: readonly StarterElementTypeRow[] = [
  {
    id: "architecture.type.interior_partition",
    name: 'Interior partition 4 7/8"',
    description: '3 5/8" metal studs with 5/8" gypsum board each side',
    forKinds: ["wall"],
    values: { "architecture.total_thickness": mm(4.875), "architecture.is_external": false, "architecture.load_bearing": false, "architecture.wall_function": "PARTITIONING" },
    size: { thicknessMm: mm(4.875) },
    toolDefault: true,
  },
  {
    id: "architecture.type.exterior_cmu_8",
    name: 'Exterior 8" CMU',
    description: '8" concrete block (7 5/8" actual), exterior',
    forKinds: ["wall"],
    values: { "architecture.total_thickness": mm(7.625), "architecture.is_external": true, "architecture.wall_function": "SOLIDWALL" },
    size: { thicknessMm: mm(7.625) },
  },
  {
    id: "architecture.type.door_single_flush_3070",
    name: "Single flush door 3'-0\" x 7'-0\"",
    description: "One flush leaf, 3 ft wide and 7 ft tall, hinged on one jamb",
    forKinds: ["opening"],
    variant: "door",
    size: { widthMm: mm(36), heightMm: mm(84) },
    toolDefault: true,
  },
  {
    id: "architecture.type.window_fixed_3040",
    name: "Fixed window 3'-0\" x 4'-0\"",
    description: "One fixed glass panel, 3 ft wide and 4 ft tall",
    forKinds: ["opening"],
    variant: "window",
    values: { "architecture.window_partitioning": "SINGLE_PANEL" },
    size: { widthMm: mm(36), heightMm: mm(48) },
    toolDefault: true,
  },
];
