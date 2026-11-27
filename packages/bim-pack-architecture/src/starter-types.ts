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
    values: { "architecture.total_thickness": mm(4.875), "architecture.is_external": false, "architecture.load_bearing": false, "architecture.wall_function": "PARTITIONING", "material.id": "architecture.gypsum_partition" },
    size: { thicknessMm: mm(4.875) },
    toolDefault: true,
  },
  {
    id: "architecture.type.exterior_cmu_8",
    name: 'Exterior 8" CMU',
    description: '8" concrete block (7 5/8" actual), exterior',
    forKinds: ["wall"],
    values: { "architecture.total_thickness": mm(7.625), "architecture.is_external": true, "architecture.wall_function": "SOLIDWALL", "material.id": "architecture.cmu_concrete" },
    size: { thicknessMm: mm(7.625) },
  },
  {
    id: "architecture.type.door_single_flush_3070",
    name: "Single flush door 3'-0\" x 7'-0\"",
    description: "One flush leaf, 3 ft wide and 7 ft tall, hinged on one jamb",
    forKinds: ["opening"],
    variant: "door",
    values: { "architecture.door_operation": "SINGLE_SWING_LEFT", "material.id": "architecture.wood_door" },
    size: { widthMm: mm(36), heightMm: mm(84) },
    toolDefault: true,
  },
  {
    id: "architecture.type.window_fixed_3040",
    name: "Fixed window 3'-0\" x 4'-0\"",
    description: "One fixed glass panel, 3 ft wide and 4 ft tall",
    forKinds: ["opening"],
    variant: "window",
    values: { "architecture.window_partitioning": "SINGLE_PANEL", "material.id": "architecture.aluminum_frame" },
    size: { widthMm: mm(36), heightMm: mm(48) },
    toolDefault: true,
  },
  {
    id: "architecture.type.railing_glass_42",
    name: "Glass guardrail 42\" (IBC commercial)",
    description: "Tempered Low-E glass panels in anodized metal shoe & cap rail, 42\" tall",
    forKinds: ["architecture.railing"],
    values: { "architecture.railing_style": "glass", "architecture.railing_height_mm": mm(42), "architecture.post_spacing_mm": mm(60), "material.id": "architecture.aluminum_frame" },
    size: { heightMm: mm(42) },
    toolDefault: true,
  },
  {
    id: "architecture.type.railing_picket_42",
    name: "Metal picket guardrail 42\" (4\" sphere)",
    description: "Vertical steel pickets spaced <= 4\" clear, 42\" commercial guard height",
    forKinds: ["architecture.railing"],
    values: { "architecture.railing_style": "picket", "architecture.railing_height_mm": mm(42), "architecture.post_spacing_mm": mm(60), "architecture.baluster_spacing_mm": 100, "material.id": "architecture.aluminum_frame" },
    size: { heightMm: mm(42) },
  },
  {
    id: "architecture.type.railing_cable_42",
    name: "Stainless cable guardrail 42\"",
    description: "Horizontal tensioned stainless cables spaced 3.75\" o.c., 42\" tall",
    forKinds: ["architecture.railing"],
    values: { "architecture.railing_style": "cable", "architecture.railing_height_mm": mm(42), "architecture.post_spacing_mm": mm(48), "architecture.baluster_spacing_mm": 95, "material.id": "architecture.aluminum_frame" },
    size: { heightMm: mm(42) },
  },
];
