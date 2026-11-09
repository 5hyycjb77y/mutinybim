import { linkedPlanDisplayOf } from "@permitzip/bim-kernel";
import { ARCHITECTURE_LINKED_PLAN_DISPLAY } from "@permitzip/bim-pack-architecture";
import { MECHANICAL_LINKED_PLAN_DISPLAY } from "@permitzip/bim-pack-mechanical";
import { PLUMBING_LINKED_PLAN_DISPLAY } from "@permitzip/bim-pack-plumbing";
import { STRUCTURAL_LINKED_PLAN_DISPLAY } from "@permitzip/bim-pack-structural";

/** The first-party add-ons' linked plan display, as a host with them installed reads it (`linkedPlanDisplay()`). */
export const FIRST_PARTY_LINKED_DISPLAY = linkedPlanDisplayOf([...PLUMBING_LINKED_PLAN_DISPLAY, ...MECHANICAL_LINKED_PLAN_DISPLAY, ...ARCHITECTURE_LINKED_PLAN_DISPLAY, ...STRUCTURAL_LINKED_PLAN_DISPLAY]);
