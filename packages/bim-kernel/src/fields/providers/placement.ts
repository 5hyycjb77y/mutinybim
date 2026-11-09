import type { ClassId, FieldProvider } from "../../registry/types";
import type { BimElement } from "../../types";
import { locked, textOrNull } from "./support";

/**
 * Placement fields every part class shares: whether it is drawn yet
 * ("Placed" / "Not placed yet", ROADMAP F1) and, for a planned part, the
 * level it will probably go on. A schedule filtered on Placement is the
 * "Not placed yet" list as a table.
 */

export const PLACEMENT_PLACED = "Placed";
export const PLACEMENT_PLANNED = "Not placed yet";

/** Every class a part is recognised as (registry/builtin.ts part categories). */
const PART_CLASSES: readonly ClassId[] = [
  "mep.mechanical_equipment",
  "mep.air_terminal",
  "mep.duct_accessory",
  "mep.pipe_accessory",
  "mep.plumbing_fixture",
  "mep.electrical_equipment",
  "mep.electrical_device",
  "mep.lighting_fixture",
  "gen.generic_model",
];

const PLACE_IT = "Place it from Not placed yet, or take it off the drawing with Unplace.";

function placementText(el: BimElement): string | null {
  if (el.kind !== "part") return null;
  return el.planned === undefined ? PLACEMENT_PLACED : PLACEMENT_PLANNED;
}

export const PLACEMENT_FIELD_PROVIDER: FieldProvider = {
  id: "placement",
  fields: [
    {
      path: "placement",
      label: "Placement",
      classes: PART_CLASSES,
      valueType: "choice",
      choices: [PLACEMENT_PLACED, PLACEMENT_PLANNED],
      writer: locked(PLACE_IT),
      group: "Location",
      description: "Placed: drawn in the model. Not placed yet: it exists (circuits, schedules, one-line) but nobody has drawn it.",
      read: (el) => placementText(el),
    },
    {
      path: "planned_level",
      label: "Planned level",
      classes: PART_CLASSES,
      valueType: "text",
      writer: locked(PLACE_IT),
      deps: { elementKinds: ["level"] },
      group: "Location",
      description: "The level a part that isn't placed yet will probably go on.",
      read: (el, ctx) => {
        if (el.kind !== "part" || el.planned?.levelHint === undefined) return null;
        const level = ctx.elements[el.planned.levelHint];
        return level?.kind === "level" ? textOrNull(level.name) : null;
      },
    },
  ],
};
