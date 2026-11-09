import type { LibraryRow } from "@permitzip/bim-kernel";

/**
 * Starter keynotes this add-on ships (a library keynote table): short keys
 * (P1, P2, …) a drawing shows in a keynote tag, worded once for the sheet's
 * keynote list. Generic notes, edited or replaced by a firm's own table in
 * the library; the keys carry the add-on's letter so tables never collide.
 */
export const PLUMBING_KEYNOTE_TABLES: readonly LibraryRow[] = [
  {
    section: "keynoteTables",
    item: {
      id: "plumbing:keynote_table:general",
      revision: 1,
      key: "plumbing:general",
      name: "Plumbing general keynotes",
      description: "Starter keynotes from the Plumbing add-on; a firm's own keynote table replaces or adds to them.",
      keynotes: [
      { key: "P1", text: "Provide a cleanout at the base of each stack.", group: "Drainage" },
      { key: "P2", text: "Slope sanitary piping 1/4 in. per foot unless noted otherwise.", group: "Drainage" },
      { key: "P3", text: "Provide a trap primer for the floor drain.", group: "Drainage" },
      { key: "P4", text: "Route the vent through the roof; coordinate the location with roofing.", group: "Venting" },
      { key: "P5", text: "Insulate domestic hot water piping.", group: "Water" },
      { key: "P6", text: "Provide a shutoff valve on each fixture branch.", group: "Water" },
      ],
    },
  },
];
