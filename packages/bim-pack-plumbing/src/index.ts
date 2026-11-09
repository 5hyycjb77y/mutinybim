/**
 * `@permitzip/bim-pack-plumbing`: the Plumbing and gas add-on (namespace
 * `plumbing_gas`). Everything consumers used to read from the kernel or from
 * bim-calc for this trade comes from here.
 */
export * from "./pack";
export { PLUMBING_LINKED_PLAN_DISPLAY } from "./linked-plan-display";
export * from "./measure";
export * from "./agent-tools";

export * from "./plumbing";
export { inchText } from "./plumbing/stacks";
export * from "./drainage";
export * from "./routing/pipe/drainage";
export * from "./routing/pipe/hydraulics";
export * from "./routing/pipe/plumbing-catalog";
export * from "./routing/pipe/families";
export * from "./routing/pipe/pipe-types";
export * from "./routing/pipe/system-pipe-type";
export * from "./routing/pipe/plumbing-settings";
export * from "./services";
export * from "./facets";
export * from "./catalog/entry-rows";
export * from "./design-limits";
export * from "./calc-sheets";
export * from "./fields/water";
export * from "./routing/pipe/gas-zones";
export * from "./routing/pipe/gas-fuel";
export * from "./routing/pipe/gas-connections";
export * from "./routing/pipe/gas-connection-checks";
export * from "./library/plumbing";
export * from "./load-points/engine";
export * from "./load-points/water-heater";
export * from "./blocks/gas-table";
export * from "./diagrams/plumbing-graph";
export * from "./diagrams/plumbing-topology";
export * from "./diagrams/piping-layout";
export * from "./diagrams/isometric-layout";
export * from "./diagrams/layout-rows";
export * from "./fields/plumbing";
export * from "./fields/gas";
export { GAS_FIELD_PROVIDER, GAS_SERVES_RULE, gasIndex, gasOutletsServedBy, type GasIndex } from "./fields/providers/gas";
export { PLUMBING_FIELD_PROVIDER } from "./fields/providers/plumbing";
export * from "./connections/plumbing/adapter";
export * from "./connect/fixtures";
export * from "./schedules/forms/fuel-forms";
export * from "./schedules/templates";

export * from "./calc/plumbing/plugins";
export * from "./calc/plumbing/code-calcs";
export * from "./calc/plumbing/settings";
export * from "./calc/plumbing/gas-system";
export * from "./calc/plumbing/system-sizing";
export * from "./calc/plumbing/size-command";
export * from "./calc/plumbing/auto-size";
export * from "./calc/plumbing/insulation";
export * from "./calc/plumbing/hunter-chart";
export * from "./calc/plumbing/drainage-checks";
export * from "./calc/packs/hunter/curves";
export { greaseFixturesPipedTo, type PipedGreaseFixture, type PipedGreaseFixtures } from "./calc/plumbing/grease-fixtures";
export * from "./lint";
export { PIPE_END_TYPES } from "./routing/pipe/end-types";
export { PIPE_PRODUCTS } from "./routing/pipe/products";
// Plain data for host screens (tab ids, labels, slots); a host imports `ADDON_UI` under its own name.
export { ADDON_UI, CLEANOUT_PROPOSAL_WORDS, FIXTURE_CONNECT_WORDS, OUTFALL_CONNECTION_WORDS } from "./ui";
// Round 12: what Plumbing › Stacks sends (moved out of the host screens).
export * from "./plumbing/stack-commands";
export * from "./plumbing/expansion-tank";
export * from "./checks/velocity-band";
export * from "./checks/wet-vent";
