import type { TagStylePresetRow } from "@permitzip/bim-kernel";

/**
 * Starter tag looks for rooms and spaces (product decision, Nov 6 review: "we don't have
 * tags for spaces"). The words are the shared field templates the kernel reads
 * for any room or space ({name}, {number}, {area}); a person turns one into a
 * project tag style from Tag styles › Start from.
 */
export const ARCHITECTURE_TAG_PRESETS: readonly TagStylePresetRow[] = [
  {
    id: "general.room",
    rank: 5,
    preset: { id: "general.room", trade: "general", name: "Room name and number", description: "The room's name over its number in a box.", lines: ["{name}", "{number}"], box: "box", appliesTo: ["room"] },
  },
  {
    id: "general.space",
    rank: 5,
    preset: { id: "general.space", trade: "general", name: "Space name, number and area", description: "The space's name and number, with its floor area under them.", lines: ["{name}", "{number}", "{area}"], box: "rounded", appliesTo: ["space"] },
  },
];
