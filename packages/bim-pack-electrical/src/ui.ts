/**
 * What a host's screens show for the Electrical add-on, as plain data: tab
 * ids and labels, where they sit, which host slots the add-on fills, and the
 * words a host shows while the add-on's screen code loads. No code and no UI
 * library: a host (a host app, a standalone MutinyBIM) pairs each id with its
 * own screen and iterates these rows without naming the trade.
 */
export const ADDON_UI = {
  addon: "electrical",
  name: "Electrical",
  tabs: [
    { id: "electrical", label: "Electrical", placement: "ribbon", plan: "electrical", scheduleStart: "electrical_device" },
    { id: "circuit", label: "Circuit", placement: "contextual" },
  ],
  scheduleTemplates: [{ key: "lighting_fixture_schedule", name: "Lighting fixture schedule" }],
  commands: [],
  slots: [{ slot: "workflow-host", id: "electrical-workflow", label: "Electrical tools", subject: "electrical" }],
  docks: [
    {
      kind: "panel",
      title: "Panel schedule",
      missing: { title: "That panel isn’t in this model", description: "It may have been deleted or renamed. Close this tab, or open another panel from Electrical › Panels." },
      readOnly: "you can't edit circuits on this model.",
      openOne: "Open {name}'s schedule beside the plan",
    },
  ],
} as const;
