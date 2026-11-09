/**
 * What a host's screens show for the Architecture add-on, as plain data: the
 * Architecture ribbon tab (Datums, Build, Types), the workflow host that
 * runs its drawing tools and fills the Architecture section of the
 * properties panel, and the names of the schedule templates it brings. No
 * code and no UI library; a host pairs each id with its
 * own screen behind `import()`.
 */
export const ADDON_UI = {
  addon: "architecture",
  name: "Architecture",
  tabs: [{ id: "architecture", label: "Architecture", placement: "ribbon" }],
  commands: [],
  slots: [{ slot: "workflow-host", id: "architecture-workflow", label: "Architecture tools", subject: "architecture" }],
  /** The schedule templates its library rows bring, by key, so New schedule… can name them while the add-on is off. */
  scheduleTemplates: [
    { key: "door_schedule", name: "Door schedule" },
    { key: "window_schedule", name: "Window schedule" },
    { key: "wall_types", name: "Wall types" },
  ],
} as const;
