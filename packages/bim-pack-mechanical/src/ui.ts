/**
 * What a host's screens show for the Mechanical add-on, as plain data:
 * commands it adds to a host's menus (with an icon name the host resolves and a place in the menu's order)
 * and the host slots it fills. No code and no UI library.
 */
export const ADDON_UI = {
  addon: "mechanical",
  name: "Mechanical",
  tabs: [{ id: "mechanical", label: "Mechanical", placement: "ribbon", plan: "mechanical", scheduleStart: "mechanical_equipment" }],
  // New schedule… names these while the add-on is off (schedules/templates.ts; keys and names kept in step by m15-air-device-schedule).
  scheduleTemplates: [
    { key: "air_device_schedule", name: "Air device schedule" },
    { key: "mechanical_equipment_schedule", name: "Mechanical equipment schedule" },
  ],
  commands: [
    { id: "sheet-ventilation-table", order: 10, label: "Ventilation table", icon: "TableProperties", testId: "ribbon-sheet-ventilation-table", target: "sheet-live-table" },
    // Mechanical › Analyze (round 15): the trade's own tab, not the Model tab. Ids and test ids stay as they were.
    { id: "model-ventilation", order: 10, label: "Ventilation", icon: "Fan", testId: "ribbon-model-ventilation", target: "trade-analyze" },
    { id: "sheet-pressurization-table", order: 20, label: "Pressurization table", icon: "Wind", testId: "ribbon-sheet-pressurization-table", target: "sheet-live-table" },
    { id: "model-kitchen-heat", order: 20, label: "Kitchen heat…", icon: "Flame", testId: "ribbon-model-kitchen-heat", target: "trade-analyze" },
  ],
  slots: [
    { slot: "rail", id: "ventilation-panel", label: "Ventilation" },
    // A routed run's Properties, in order among the host's own sections (insulation 30, hydraulics 50).
    { slot: "run-section", id: "run-transition-shape", label: "Transition shape", order: 10 },
    { slot: "run-section", id: "run-design", label: "Duct design", order: 20 },
    { slot: "run-section", id: "run-pressure", label: "Pressure", order: 40 },
    { slot: "part-section", id: "part-air-side", label: "Mount, hoods and flex" },
    { slot: "route-section", id: "route-design", label: "Insulation and airflow" },
    { slot: "rail", id: "kitchen-heat-panel", label: "Kitchen heat" },
    { slot: "space-loads-section", id: "space-kitchen-heat", label: "Kitchen heat" },
    { slot: "workflow-host", id: "mechanical-workflow", label: "Mechanical tools", subject: "mechanical" },
  ],
} as const;

/** The live diagram kind Mechanical › Diagrams › Air schematic opens (stored on the view; frozen once stored). */
export const AIR_SCHEMATIC_KIND = "air_schematic";

/** Mechanical › Connect › To duct (round 15): the button, the preview window and the undo label. */
export const AIR_CONNECT_WORDS = {
  label: "To duct",
  description: "Join the selected diffusers, grilles and units to the nearest duct of their system: a tap on the duct, a short straight piece and flex into each neck, in one undo",
  keywords: ["connect", "connect diffusers", "tap", "flex", "neck", "branch", "takeoff", "tie in", "duct"],
  title: "Connect to duct",
  connectAll: (n: number) => `Connect ${n}`,
  close: "Cancel",
  flex: (ft: string) => `${ft} ft flex`,
  escHint: "Esc closes. Nothing changes until you press Connect; one Undo takes it all back.",
  undo: "connect the air devices to the duct",
  selectFirst: "Select the diffusers, grilles or units to connect first.",
  noneHave: "None of the selected items has a duct connection.",
  allConnected: "Every selected duct connection is already connected.",
  noneJoin: "None of these can be connected as they stand. Each line says why.",
  done: (joined: number, of: number) => `Connected ${joined} of ${of}.`,
  peerMissing: "The model server doesn't connect air devices into ducts yet. Ask your admin to update it, or route each branch by hand.",
} as const;

/** Mechanical › Analyze › Size ducts (round 15): every run of the selected air systems by each system's sizing rule. */
export const SIZE_DUCTS_WORDS = {
  label: "Size ducts",
  description: "Size every duct run of the selected air systems from the airflow it carries, by each system's friction rate and velocity limit; see each change first, one undo",
  keywords: ["size ducts", "duct sizing", "auto-size", "friction rate", "velocity", "equal friction", "resize", "cfm"],
  title: "Size ducts",
  apply: (n: number) => `Resize ${n}`,
  close: "Cancel",
  escHint: "Esc closes. Nothing changes until you press Resize; one Undo takes it all back.",
  undo: "size the ducts",
  selectFirst: "Select a duct, diffuser or unit on the air system to size.",
  noAirSystem: "Nothing selected is on an air system. Select a duct, or a diffuser connected to one.",
  nothingToChange: "Every run is already the size its airflow calls for.",
  done: (n: number) => `Resized ${n} ${n === 1 ? "run" : "runs"}.`,
} as const;
