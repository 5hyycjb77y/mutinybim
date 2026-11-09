import {
  CALC_POINT,
  CLASS_POINT,
  DERIVED_ZONE_RULE_POINT,
  LIBRARY_ROWS_POINT,
  LINKED_PLAN_DISPLAY_POINT,
  LINKED_REFERENCE_POINT,
  LINT_RULE_POINT,
  NETWORK_ADAPTER_POINT,
  PARAMETER_SET_POINT,
  SERVICE_POINT,
  SPACE_USE_POINT,
  SPACE_USE_RATE_POINT,
  SPACE_USE_RATE_VALUE_POINT,
  ZONE_PURPOSE_POINT,
  contribute,
  definePack,
  FIELD_PROVIDER_POINT,
  type RuleDef,
} from "@permitzip/bim-pack/runtime";
import { STRUCTURAL_MANIFEST } from "@permitzip/bim-kernel/packs";
import { SIMPLE_BEAM_CALC } from "./calc";
import { GRAVITY_LOAD_SERVICE, STRUCT_CLASSES, STRUCT_PARAMETER_SET } from "./catalog";
import { STRUCTURAL_CLASSES } from "./classes";
import { STRUCTURAL_FIELD_PROVIDER } from "./fields";
import { STRUCT_LIBRARY_ROWS } from "./library-rows";
import { STRUCTURAL_LINKED_PLAN_DISPLAY } from "./linked-plan-display";
import { STRUCTURAL_LINKED_REFERENCE } from "./linked-reference";
import { FOOTING_UNSUPPORTED_RULE_ID, FOOTING_UNSUPPORTED_RULE_VERSION, footingUnsupported } from "./lint";
import { LIVE_LOAD_RATE_TARGET, STRUCT_RATE_VALUES, STRUCT_SPACE_USES } from "./live-loads";
import { LOAD_PATH_ADAPTER } from "./load-path";
import { TRIBUTARY_PURPOSE, TRIBUTARY_RULE } from "./tributary-zone";

export const STRUCT_PACK_ID = STRUCTURAL_MANIFEST.id;
export const STRUCT_PACK_VERSION = STRUCTURAL_MANIFEST.version;

export const FOOTING_UNSUPPORTED_RULE: RuleDef = {
  id: FOOTING_UNSUPPORTED_RULE_ID,
  version: FOOTING_UNSUPPORTED_RULE_VERSION,
  pack: STRUCT_PACK_ID,
  severity: "error",
  title: "Column with no footing below it",
  scope: "element",
  kinds: ["column"],
  // A footing removed or moved changes this rule's answer for a column nowhere near the edit.
  reads: ["component", "column"],
  run(ctx, el) {
    const f = footingUnsupported(ctx.model, el);
    if (f) ctx.emit({ rule: f.rule, severity: f.severity, elementIds: f.elementIds, at: f.at, message: f.message, ...(f.fix ? { fix: f.fix } : {}) });
  },
};

/**
 * The Structural add-on, first-party since round 14: installed in every host
 * and on in every model (it was a Preview add-on a model switched on). Its
 * classes start with the four the kernel used to carry (`struct.grid`,
 * `struct.column`, `struct.beam`, `struct.footing`), then its own.
 */
export const STRUCTURAL_PACK = definePack(STRUCTURAL_MANIFEST, [
  contribute(CLASS_POINT, [...STRUCTURAL_CLASSES, ...STRUCT_CLASSES]),
  contribute(FIELD_PROVIDER_POINT, [{ id: "struct.members", provider: STRUCTURAL_FIELD_PROVIDER, rank: 10 }]),
  contribute(PARAMETER_SET_POINT, [STRUCT_PARAMETER_SET]),
  contribute(SERVICE_POINT, [GRAVITY_LOAD_SERVICE]),
  contribute(NETWORK_ADAPTER_POINT, [LOAD_PATH_ADAPTER]),
  contribute(DERIVED_ZONE_RULE_POINT, [TRIBUTARY_RULE]),
  contribute(ZONE_PURPOSE_POINT, [TRIBUTARY_PURPOSE]),
  contribute(SPACE_USE_RATE_POINT, [LIVE_LOAD_RATE_TARGET]),
  contribute(SPACE_USE_POINT, STRUCT_SPACE_USES),
  contribute(SPACE_USE_RATE_VALUE_POINT, STRUCT_RATE_VALUES),
  contribute(LINT_RULE_POINT, [FOOTING_UNSUPPORTED_RULE]),
  contribute(CALC_POINT, [SIMPLE_BEAM_CALC]),
  contribute(LIBRARY_ROWS_POINT, STRUCT_LIBRARY_ROWS),
  contribute(LINKED_PLAN_DISPLAY_POINT, STRUCTURAL_LINKED_PLAN_DISPLAY),
  contribute(LINKED_REFERENCE_POINT, STRUCTURAL_LINKED_REFERENCE),
]);
