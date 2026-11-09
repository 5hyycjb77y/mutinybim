/**
 * The words the one-line and riser diagram tools (bim_preview_one_line,
 * bim_layout_one_line) and the catalog save tool advertise: descriptions,
 * argument docs and the command families read in full with
 * bim_describe_commands. Moved here from the host's tool files in round 10, so
 * the host registers the tools and the trade's words come from the add-on.
 * Byte for byte what the tools advertised before (the tool-budget and
 * snapshot tests hold the token counts).
 */

export interface AgentToolCopy {
  readonly title: string;
  readonly description: string;
}

/** A tool argument advertised in a short form, its exact fields read with bim_describe_commands. */
export interface AgentCommandFamilyCopy {
  readonly tool: string;
  readonly field: string;
  /** What the family is, in plain words. */
  readonly label: string;
  /** The key that names a variant, for a union. */
  readonly discriminator?: string;
  /** The variants the short form lists, in order. */
  readonly variants?: readonly [string, ...string[]];
}

export const ONE_LINE_TOOL_COPY = {
  bim_preview_one_line: {
    title: "Preview a one-line diagram",
    description:
      "Preview a diagram without saving: what it draws, warnings (bus vs feeding breaker), size, and would_save with a preview_token for bim_layout_one_line. from_model: true (the normal case) makes a LIVE diagram drawn from the model at every revision: kind one_line, electrical_riser, plumbing_riser (branches, sizes, running DFU/WFU/MBH; pipes listed) or plumbing_isometric, with layout hints; with view, an existing drafting view becomes live or gets new hints. diagram (static) is only for a distribution described by hand with no model: roots are utility/generator sources; children CT cabinet, meter, switchboard / panelboard / MCC with a main, transformer, ATS with its emergency generator, disconnects, VFD, UPS, motors; each with name, ratings and its feeder (device, label, sets, conductors, conduit, length). Free; no approval.",
  },
  bim_layout_one_line: {
    title: "Draw a one-line diagram",
    description:
      "Save what bim_preview_one_line previewed, as one change: a live diagram view (or its new hints), or the static drawing, and (place_on) its viewport on a sheet. Same arguments plus the preview's base_revision and preview_token; anything different is refused. A live diagram redraws itself when the model changes; change its layout by calling again with view and hints. Look at it after with bim_render_view_image.",
  },
} as const satisfies Record<string, AgentToolCopy>;

/** Argument docs both one-line tools share. */
export const ONE_LINE_ARG_COPY = {
  diagram: "Static only, for a distribution with no model: the distribution, top down (exact fields: bim_describe_commands field diagram). Otherwise use from_model.",
  from_model: "A live diagram drawn from the model's feeders (or plumbing systems) at every revision; with view, an existing drafting view becomes live (or its hints change).",
  kind: "Live diagram: one_line (default), electrical_riser, plumbing_riser or plumbing_isometric.",
  hints: "Live diagram layout hints, merged over the view's: orientation, style (box3d), detail (schematic), order {parentId:[childIds]}, pins {id:{dx,dy}} mm, textOffsets {key:{dx,dy,leader?}} mm (moves one block of text; keys from the preview's texts), sections, futureSpaces {busId:n}, hidden, roots, utility, showWarnings, showLoads, labels (field templates), title, notes; piping: systemKinds, pipeLabels. Exact fields: bim_describe_commands field hints.",
} as const;

export const COMMAND_FAMILY_COPY: readonly AgentCommandFamilyCopy[] = [
  { tool: "bim_save_electrical_type", field: "entry", label: "One catalog record to save: a connection type, feeder type or room template.", discriminator: "type", variants: ["connection_type", "feeder_type", "circuit_template"] },
  ...(["bim_preview_one_line", "bim_layout_one_line"] as const).flatMap((tool): AgentCommandFamilyCopy[] => [
    { tool, field: "diagram", label: "A distribution described by hand (no model), top down: sources, equipment, ratings and feeders." },
    { tool, field: "hints", label: "Live diagram layout hints, merged over the view's." },
  ]),
];
