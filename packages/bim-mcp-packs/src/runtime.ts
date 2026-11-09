/**
 * What every pack's tools are written against: the caller runtime and the
 * answers of the tool server, under the names the tools have always used.
 */
export {
  BASE_REVISION as baseRevision,
  PROJECT_TARGET as target,
  TRADE_BASE_REVISION as tradeBaseRevision,
  TRADE_TARGET as tradeTarget,
  area,
  classMembers,
  describeEditResult,
  editAs,
  editIdempotencyKey,
  editResultBody,
  explain,
  failure,
  interestOf,
  notSent,
  readAs,
  runEdit,
  text,
  withAreaSession,
  withRefusalShape,
  withSession,
  type BeforeEditAnswer,
  type BimCaller,
  type BuiltCommand,
  type Extra,
  type ResolveBimCaller,
  type ToolResult,
} from "@permitzip/bim-mcp";
