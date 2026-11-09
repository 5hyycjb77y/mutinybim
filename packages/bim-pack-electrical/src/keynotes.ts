import type { LibraryRow } from "@permitzip/bim-kernel";

/**
 * Starter keynotes this add-on ships (a library keynote table): short keys
 * (E1, E2, …) a drawing shows in a keynote tag, worded once for the sheet's
 * keynote list. Generic notes, edited or replaced by a firm's own table in
 * the library; the keys carry the add-on's letter so tables never collide.
 */
export const ELECTRICAL_KEYNOTE_TABLES: readonly LibraryRow[] = [
  {
    section: "keynoteTables",
    item: {
      id: "electrical:keynote_table:general",
      revision: 1,
      key: "electrical:general",
      name: "Electrical general keynotes",
      description: "Starter keynotes from the Electrical add-on; a firm's own keynote table replaces or adds to them.",
      keynotes: [
      { key: "E1", text: "Provide GFCI protection.", group: "Devices" },
      { key: "E2", text: "Mount the device at the height noted on the elevations.", group: "Devices" },
      { key: "E3", text: "Coordinate the device location with the furniture layout.", group: "Devices" },
      { key: "E4", text: "Provide a dedicated circuit.", group: "Circuits" },
      { key: "E5", text: "Home run to the panel shown.", group: "Circuits" },
      { key: "E6", text: "Provide a disconnect within sight of the equipment.", group: "Equipment" },
      ],
    },
  },
];
