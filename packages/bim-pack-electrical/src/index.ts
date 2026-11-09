/**
 * `@permitzip/bim-pack-electrical`: the Electrical add-on. `ELECTRICAL_PACK`
 * (installed in every host through `@permitzip/bim-first-party`) and every
 * electrical engine, calc, read and type the screens, tools and other add-ons
 * use. Apache-2.0; built only on the kernel's published entries, `bim-calc`
 * and the add-on contract. The kernel imports nothing from it.
 */
export * from "./pack";
export * from "./catalog";
export * from "./facets";
export * from "./services/rows";
export * from "./design-limits";
export * from "./measure";
export * from "./agent-tools";
export * from "./script-reads";
export * from "./annotation/electrical-symbols";
export * from "./annotation/circuit-graphics";
export * from "./calc/aggregation-rules";
export * from "./calc/demand";
export * from "./calc/equipment-list";
export * from "./calc/fault-current";
export * from "./calc/feeder-type";
export * from "./calc/motor";
export * from "./calc/nec";
export * from "./calc/plugins";
export * from "./calc/service-size";
export * from "./calc/size-circuit";
export * from "./calc/working-space";
export * from "./connections/adapter";
export * from "./connections/balance";
export * from "./connections/check";
export * from "./connections/dedicated-circuits";
export * from "./connections/engine";
export * from "./connections/equipment";
export * from "./connections/equipment-connection";
export * from "./connections/estimates";
export * from "./connections/fed-from";
export * from "./connections/inventory";
export * from "./connections/loads";
export * from "./connections/panel";
export * from "./connections/proposals";
export * from "./connections/readiness";
export * from "./connections/rebalance";
export * from "./connections/rules";
export * from "./connections/service-layout";
export * from "./connections/sources";
export * from "./connections/synthetic";
export * from "./connections/systems";
export * from "./connections/templates";
export * from "./diagrams/electrical-graph";
export * from "./diagrams/one-line-layout";
export * from "./diagrams/one-line-model";
export * from "./diagrams/feeder-types";
export * from "./fields/electrical-resolver";
export * from "./fields/feeder-types";
export * from "./fields/providers/electrical";
export * from "./fields/rules-registry";
export * from "./library/electrical";
export * from "./propose/types";
export * from "./propose/accept";
export * from "./propose/receptacles";
export * from "./propose/proposer";
export * from "./propose/device-choices";
export * from "./propose/agent-proposal";
export * from "./schedules/distribution-forms";
export * from "./schedules/distribution-templates";
export * from "./schedules/list-templates";
// Two modules name a `DemandInput`: the load engine's (what a demand rule set reads) is the package's; the calc's is `DemandCalcInput`.
export type { DemandInput } from "./connections/rules";
export type { DemandInput as DemandCalcInput } from "./calc/demand";
export * from "./lint";
// Plain data for host screens (tab ids, labels, slots); a host imports `ADDON_UI` under its own name.
export { ADDON_UI } from "./ui";
export * from "./agent-copy";
// Round 12: circuit planning (what Add to circuit, Edit circuit, Feed and the "+" grip send), moved out of the host screens.
export * from "./circuiting/plan";
export * from "./circuiting/drop";
export * from "./circuiting/link-load";
export * from "./circuiting/connect";
export * from "./circuiting/continue";
