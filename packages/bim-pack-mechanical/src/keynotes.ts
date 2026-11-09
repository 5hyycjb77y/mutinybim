import type { LibraryRow } from "@permitzip/bim-kernel";

/**
 * Starter keynotes this add-on ships (a library keynote table): short keys
 * (M1, M2, …) a drawing shows in a keynote tag, worded once for the sheet's
 * keynote list. Generic notes, edited or replaced by a firm's own table in
 * the library; the keys carry the add-on's letter so tables never collide.
 */
export const MECHANICAL_KEYNOTE_TABLES: readonly LibraryRow[] = [
  {
    section: "keynoteTables",
    item: {
      id: "mechanical:keynote_table:general",
      revision: 1,
      key: "mechanical:general",
      name: "Mechanical general keynotes",
      description: "Starter keynotes from the Mechanical add-on; a firm's own keynote table replaces or adds to them.",
      keynotes: [
      { key: "M1", text: "Provide a fire damper where the duct crosses a rated wall or floor.", group: "Ductwork" },
      { key: "M2", text: "Provide a flexible duct connection at the equipment.", group: "Ductwork" },
      { key: "M3", text: "Seal duct penetrations through rated assemblies.", group: "Ductwork" },
      { key: "M4", text: "Route condensate to the nearest approved receptor.", group: "Equipment" },
      { key: "M5", text: "Provide an access panel for damper and valve service.", group: "Equipment" },
      { key: "M6", text: "Balance air devices to the airflow shown.", group: "Air devices" },
      ],
    },
  },
];
