/**
 * `@permitzip/bim-mcp`: the MutinyBIM tool server. One small core pack
 * (script execution first, four reads), a host adapter (identity,
 * authorization, approval, script runner, model server) and an extension
 * point for add-on packs. Hosts register the core on their own server
 * (`registerBimCoreTools`) or start a ready one (`createBimToolServer`);
 * `@permitzip/bim-mcp/local` is the open host for one person's computer.
 */
export * from "./host";
export * from "./approvals";
export * from "./answers";
export { BASE_REVISION, TRADE_BASE_REVISION, TRADE_TARGET, PROJECT_SCHEMAS, PROJECT_TARGET, LOCAL_SCHEMAS, LOCAL_PROJECT_ID, area, type CoreSchemas, type ProjectIdSchema } from "./schemas";
export { interestOf, withAreaSessionVia, type SessionOpener } from "./area";
export { resolveAreaLevel, resolveLevelRef } from "./level-ref";
export { registerBimScriptTools, approvalIo, SEALED_MACHINE_WORDS, type ScriptToolHelpers, type ScriptToolOptions } from "./scripts/tools";
export {
  SCRIPT_APPLY_TOOL,
  SCRIPT_SAVE_PART_TYPE_TOOL,
  SCRIPT_TOOL_PACK_ID,
  SESSION_APPROVAL_MAX_CHANGES,
  scriptApprovalTier,
  scriptCallAllowsSessionApproval,
  scriptRunAllowed,
  type ScriptApprovalTier,
  type ScriptChangeSummary,
} from "./scripts/tier";
export { editsChange, outputHash, partTypesChange, type ScriptChangeReport } from "./scripts/change-summary";
export { classMembers, registerBimNetworkReadTools, registerBimSummaryReadTools } from "./reads/tools";
export { chainOf, notPlacedYet, questionsList, withDesignFacts } from "./reads/design-reads";
export { agentImpactOfRemoving, agentWhy, type AgentAnswer } from "./reads/graph";
export { BIM_TOOL_SERVER_VERSION, CORE_READ_TOOLS, CORE_TOOLS, CORE_TOOL_BUDGET, PACK_CONTROL_TOOL, TOOL_FAMILIES, coreToolsOutsideCatalogue, createBimToolServer, familySlug, packProblems, registerBimCoreTools, toolFamily, type BimToolPack, type BimToolServerOptions, type CoreToolOptions, type ToolCallWrapper, type ToolHandler } from "./server";
export { editAs, editIdempotencyKey, readAs, runEdit, withAreaSession, withSession, type BeforeEditAnswer, type BimCaller, type Extra, type ResolveBimCaller } from "./caller";
