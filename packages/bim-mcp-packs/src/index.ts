/**
 * `@permitzip/bim-mcp-packs`: the MutinyBIM tool families beyond the core,
 * as add-on packs for the tool server. Each family registers through the same
 * caller runtime (`./runtime`) and declares the host services it needs in its
 * own `capabilities.ts`; `registerBimToolPacks` puts every family on one
 * server in one order, and `localToolPacks` is that over one person's own
 * computer.
 */
export * from "./runtime";
export * from "./capabilities";
export { registerBimToolPacks, type BimToolPacksHost } from "./compose";
export { localToolPacks, localToolPacksHost } from "./local";
export { BIM_ADDITIVE_TOOL_NAMES, BIM_OPEN_WORLD_TOOL_NAMES, bimToolAnnotations, withBimToolAnnotations } from "./support/tool-annotations";
export * as calc from "./calc/index";
export * as coordination from "./coordination/index";
export * as drawings from "./drawings/index";
export * as library from "./library/index";
export * as models from "./models/index";
export * as parts from "./parts/index";
export * as routing from "./routing/index";
export * as trades from "./trades/index";
export * as views from "./views/index";
