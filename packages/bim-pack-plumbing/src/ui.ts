/**
 * What a host's screens show for the Plumbing and gas add-on, as plain data:
 * tab ids and labels, commands it adds to a host's menus (with an icon name
 * the host resolves), which host slots it fills, and the words a host shows
 * while the add-on's screen code loads. No code and no UI library.
 */
export const ADDON_UI = {
  addon: "plumbing_gas",
  name: "Plumbing and gas",
  tabs: [{ id: "plumbing", label: "Plumbing", placement: "ribbon", plan: "plumbing", scheduleStart: "plumbing_fixture" }],
  // New schedule… names these while the add-on is off (schedules/templates.ts; keys and names kept in step by p15-fixture-schedule-template).
  scheduleTemplates: [
    { key: "plumbing_fixture_schedule", name: "Plumbing fixture schedule" },
    { key: "water_heater_schedule", name: "Water heater schedule" },
    { key: "pump_schedule", name: "Pump schedule" },
  ],
  commands: [{ id: "sheet-gas-schedule", order: 30, label: "Gas schedule", icon: "Flame", testId: "ribbon-sheet-gas-schedule", target: "sheet-live-table" }],
  slots: [
    { slot: "inspector-section", id: "load-point", label: "Load point properties", elementKind: "load_point" },
    { slot: "workflow-host", id: "plumbing-workflow", label: "Plumbing tools", subject: "plumbing" },
    // A routed run's Properties: the inline form above the piece's details, hydraulics after its pressure.
    { slot: "run-section", id: "run-inline", label: "Inline fitting", order: -10 },
    { slot: "run-section", id: "run-hydraulics", label: "Hydraulics", order: 50 },
  ],
} as const;

/** The words of Plumbing › Systems › Sewer connection and its dialog, for the host's screens. */
export const OUTFALL_CONNECTION_WORDS = {
  label: "Sewer connection",
  description: "Take the selected building drain to the street manhole (pick one or enter its invert and rim), then check the fall and backwater on the way",
  keywords: ["sewer", "manhole", "building sewer", "invert", "rim", "backwater valve", "ejector", "outfall", "tie-in"],
  title: "Sewer connection",
  intro: "Take the selected drain to the street manhole, then check the fall and backwater on the way.",
  routeUndo: "route the drain to the sewer connection",
  joinUndo: "connect the drain to the manhole",
} as const;

/** Systems › Propose cleanouts (round 14): the button, the panel over the plan, and the undo label; in this add-on's words so shared screens stay trade-neutral. */
export const CLEANOUT_PROPOSAL_WORDS = {
  label: "Propose cleanouts",
  description: "Show where cleanouts go on the selected drain (its upper end, each turn over 45°, every 100 ft, the sewer connection) as ghosts; approve them to put them in the pipe",
  keywords: ["cleanout", "clean out", "co", "drain", "propose", "ghost", "access"],
  title: "Proposed cleanouts",
  loading: "Looking along the drain…",
  none: "This drain already has the cleanouts it needs.",
  approve: "Approve",
  approveAll: "Approve all",
  dismiss: "Dismiss",
  close: "Close",
  select: "Select",
  escHint: "Esc closes and clears the ghosts. Nothing is placed until you approve.",
  undo: "place cleanouts on the drain",
  peerMissing: "The model server doesn't take parts put in a pipe yet, so nothing can be approved. Ask your admin to update it.",
  selectDrain: "Select a level drain pipe first (Propose cleanouts reads the drain it is on).",
} as const;

/** Plumbing › Connect (round 15): join the selected fixtures to the nearest drain, vent, cold or hot water run; the button, its menu, the preview panel and the undo label. */
export const FIXTURE_CONNECT_WORDS = {
  label: "Connect",
  description: "Join the selected fixtures and equipment to the nearest drain, vent, cold or hot water pipe: trap arms, the system's fittings and slope, in one undo",
  keywords: ["connect", "connect fixtures", "auto connect", "drain", "vent", "cold water", "hot water", "trap arm", "wye", "sanitary tee", "tie in"],
  title: "Connect fixtures",
  connectAll: (n: number) => `Connect ${n}`,
  close: "Cancel",
  closeDone: "Close",
  select: "Select",
  flex: "flexible connection",
  escHint: "Esc closes. Nothing changes until you press Connect; one Undo takes it all back.",
  selectFirst: "Select the fixtures or equipment to connect first.",
  noneJoin: "None of these can be connected as they stand. Each line says why.",
  done: (joined: number, of: number) => `Connected ${joined} of ${of}.`,
  peerMissing: "The model server doesn't connect fixtures into pipes yet. Ask your admin to update it, or route each pipe by hand.",
  target: {
    drain: { label: "To drain", description: "Each fixture's waste into the nearest sanitary pipe: trap arm, combination wye and 1/8 bend into a level drain, sanitary tee into a stack, at the system's slope", undo: "connect the fixtures to the drain", noneHave: "None of the selected items has a waste connection.", allConnected: "Every selected waste connection is already connected." },
    vent: { label: "To vent", description: "Each fixture's vent up into the nearest vent pipe of its system (a vent main or the stack that goes through the roof)", undo: "connect the fixtures to the vent", noneHave: "None of the selected items has a vent connection. Fixtures placed before round 15 have none: place them again to get one.", allConnected: "Every selected vent connection is already connected." },
    cold_water: { label: "To cold water", description: "Each fixture's cold water into the nearest cold water pipe", undo: "connect the fixtures to cold water", noneHave: "None of the selected items has a cold water connection.", allConnected: "Every selected cold water connection is already connected." },
    hot_water: { label: "To hot water", description: "Each fixture's hot water into the nearest hot water pipe", undo: "connect the fixtures to hot water", noneHave: "None of the selected items has a hot water connection.", allConnected: "Every selected hot water connection is already connected." },
  },
} as const;
