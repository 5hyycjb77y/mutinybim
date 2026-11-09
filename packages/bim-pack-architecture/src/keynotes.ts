import type { LibraryRow } from "@permitzip/bim-kernel";

/**
 * Starter keynotes this add-on ships (a library keynote table): short keys
 * (A1, A2, …) a drawing shows in a keynote tag, worded once for the sheet's
 * keynote list. Generic notes, edited or replaced by a firm's own table in
 * the library; the keys carry the add-on's letter so tables never collide.
 */
export const ARCHITECTURE_KEYNOTE_TABLES: readonly LibraryRow[] = [
  {
    section: "keynoteTables",
    item: {
      id: "architecture:keynote_table:general",
      revision: 1,
      key: "architecture:general",
      name: "Architectural general keynotes",
      description: "Starter keynotes from the Architecture add-on; a firm's own keynote table replaces or adds to them.",
      keynotes: [
      { key: "A1", text: "Fire-rated partition; see the wall types.", group: "Walls" },
      { key: "A2", text: "Provide blocking in the wall for wall-hung equipment.", group: "Walls" },
      { key: "A3", text: "Seal penetrations through rated assemblies.", group: "Walls" },
      { key: "A4", text: "Provide an access door; coordinate its size with the trade served.", group: "Openings" },
      { key: "A5", text: "Align the finish with the adjacent surface.", group: "Finishes" },
      { key: "A6", text: "Verify the dimension in the field.", group: "General" },
      ],
    },
  },
];
